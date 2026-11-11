//! Loopback HTTP server that streams torrent files to the media player.
//!
//! `GET /stream/<id>/<file>` with HTTP Range support, backed by librqbit's per-file
//! `ManagedTorrent::stream`, which prioritises the pieces under the read position.
//! A minimal HTTP/1.1 implementation over tokio is used instead of hyper to keep the binary small.
//! The server only listens on 127.0.0.1.

use std::io::SeekFrom;
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use librqbit::api::TorrentIdOrHash;
use librqbit::dht::Id20;
use librqbit::Session;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;
use tokio::time::timeout;

const HEAD_LIMIT: usize = 16 * 1024;
const HEAD_TIMEOUT: Duration = Duration::from_secs(10);
/// A read that waits longer than this for a piece ends the response; players retry with a new Range.
const READ_TIMEOUT: Duration = Duration::from_secs(120);
const WRITE_TIMEOUT: Duration = Duration::from_secs(60);
const CHUNK: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestHead {
    pub method: String,
    pub path: String,
    pub range: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RangeSpec {
    Full,
    /// Inclusive byte range.
    Partial { start: u64, end: u64 },
    Unsatisfiable,
}

/// Parses the request line and the headers we care about from a complete head (up to the blank line).
pub fn parse_request_head(head: &str) -> Option<RequestHead> {
    let mut lines = head.split("\r\n");
    let first = lines.next()?;
    let mut parts = first.split_whitespace();
    let method = parts.next()?.to_ascii_uppercase();
    let path = parts.next()?.to_string();
    let version = parts.next()?;
    if !version.starts_with("HTTP/1.") {
        return None;
    }
    let mut range = None;
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            if k.trim().eq_ignore_ascii_case("range") {
                range = Some(v.trim().to_string());
            }
        }
    }
    Some(RequestHead { method, path, range })
}

/// `/stream/<40 hex id>/<file index>[/anything]` -> (id, file index). Query strings are ignored.
pub fn parse_stream_path(path: &str) -> Option<(String, usize)> {
    let path = path.split(['?', '#']).next()?;
    let mut seg = path.split('/');
    if seg.next()? != "" || seg.next()? != "stream" {
        return None;
    }
    let id = seg.next()?;
    if id.len() != 40 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let file: usize = seg.next()?.parse().ok()?;
    Some((id.to_ascii_lowercase(), file))
}

/// Resolves a `Range` header against the file length. Syntax we do not understand is ignored (full body),
/// as RFC 9110 allows. Only the first range of a multi-range request is served.
pub fn parse_range(header: Option<&str>, len: u64) -> RangeSpec {
    let h = match header {
        Some(h) => h.trim(),
        None => return RangeSpec::Full,
    };
    let spec = match h.strip_prefix("bytes=") {
        Some(s) => s.split(',').next().unwrap_or("").trim(),
        None => return RangeSpec::Full,
    };
    let (a, b) = match spec.split_once('-') {
        Some(ab) => ab,
        None => return RangeSpec::Full,
    };
    let (a, b) = (a.trim(), b.trim());
    if len == 0 {
        return RangeSpec::Full;
    }
    if a.is_empty() {
        // Suffix range: the last n bytes.
        return match b.parse::<u64>() {
            Ok(0) => RangeSpec::Unsatisfiable,
            Ok(n) => RangeSpec::Partial {
                start: len.saturating_sub(n),
                end: len - 1,
            },
            Err(_) => RangeSpec::Full,
        };
    }
    let start = match a.parse::<u64>() {
        Ok(s) => s,
        Err(_) => return RangeSpec::Full,
    };
    let end = if b.is_empty() {
        len - 1
    } else {
        match b.parse::<u64>() {
            Ok(e) => e,
            Err(_) => return RangeSpec::Full,
        }
    };
    if end < start {
        return RangeSpec::Full;
    }
    if start >= len {
        return RangeSpec::Unsatisfiable;
    }
    RangeSpec::Partial {
        start,
        end: end.min(len - 1),
    }
}

pub fn mime_for_extension(ext: &str) -> &'static str {
    match ext.to_ascii_lowercase().as_str() {
        "mp4" | "m4v" => "video/mp4",
        "mkv" => "video/x-matroska",
        "webm" => "video/webm",
        "avi" => "video/x-msvideo",
        "mov" => "video/quicktime",
        "ts" => "video/mp2t",
        "mp3" => "audio/mpeg",
        "m4a" | "aac" => "audio/mp4",
        "flac" => "audio/flac",
        "ogg" | "opus" => "audio/ogg",
        "wav" => "audio/wav",
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "pdf" => "application/pdf",
        "txt" | "srt" | "nfo" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

async fn write_simple(sock: &mut TcpStream, status: &str, body: &str) {
    let resp = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = timeout(WRITE_TIMEOUT, sock.write_all(resp.as_bytes())).await;
}

async fn read_head(sock: &mut TcpStream) -> Option<String> {
    let mut buf: Vec<u8> = Vec::with_capacity(1024);
    let mut tmp = [0u8; 1024];
    loop {
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            buf.truncate(pos);
            return String::from_utf8(buf).ok();
        }
        if buf.len() > HEAD_LIMIT {
            return None;
        }
        let n = sock.read(&mut tmp).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&tmp[..n]);
    }
}

async fn handle_connection(mut sock: TcpStream, session: Arc<Session>) {
    let head = match timeout(HEAD_TIMEOUT, read_head(&mut sock)).await {
        Ok(Some(h)) => h,
        _ => {
            write_simple(&mut sock, "400 Bad Request", "Bad request").await;
            return;
        }
    };
    let req = match parse_request_head(&head) {
        Some(r) => r,
        None => {
            write_simple(&mut sock, "400 Bad Request", "Bad request").await;
            return;
        }
    };
    if req.method != "GET" && req.method != "HEAD" {
        write_simple(&mut sock, "405 Method Not Allowed", "Use GET").await;
        return;
    }
    let (id, file) = match parse_stream_path(&req.path) {
        Some(x) => x,
        None => {
            write_simple(&mut sock, "404 Not Found", "Not found").await;
            return;
        }
    };
    let hash = match Id20::from_str(&id) {
        Ok(h) => h,
        Err(_) => {
            write_simple(&mut sock, "404 Not Found", "Not found").await;
            return;
        }
    };
    let handle = match session.get(TorrentIdOrHash::Hash(hash)) {
        Some(h) => h,
        None => {
            write_simple(&mut sock, "404 Not Found", "That torrent isn't in your list").await;
            return;
        }
    };
    let mime = handle
        .with_metadata(|m| {
            m.file_infos
                .get(file)
                .and_then(|fi| fi.relative_filename.extension())
                .and_then(|e| e.to_str())
                .map(mime_for_extension)
                .unwrap_or("application/octet-stream")
        })
        .unwrap_or("application/octet-stream");

    let mut stream = match handle.clone().stream(file).await {
        Ok(s) => s,
        Err(_) => {
            write_simple(&mut sock, "404 Not Found", "That file can't be streamed right now").await;
            return;
        }
    };
    let len = stream.len();
    let (status, start, end, content_range) = match parse_range(req.range.as_deref(), len) {
        RangeSpec::Full => ("200 OK", 0u64, len.saturating_sub(1), None),
        RangeSpec::Partial { start, end } => (
            "206 Partial Content",
            start,
            end,
            Some(format!("bytes {start}-{end}/{len}")),
        ),
        RangeSpec::Unsatisfiable => {
            let resp = format!(
                "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{len}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            );
            let _ = timeout(WRITE_TIMEOUT, sock.write_all(resp.as_bytes())).await;
            return;
        }
    };
    let body_len = if len == 0 { 0 } else { end - start + 1 };
    let mut headers = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {mime}\r\nContent-Length: {body_len}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n"
    );
    if let Some(cr) = content_range {
        headers.push_str(&format!("Content-Range: {cr}\r\n"));
    }
    headers.push_str("\r\n");
    if timeout(WRITE_TIMEOUT, sock.write_all(headers.as_bytes()))
        .await
        .map(|r| r.is_err())
        .unwrap_or(true)
    {
        return;
    }
    if req.method == "HEAD" || body_len == 0 {
        return;
    }
    if start > 0 && stream.seek(SeekFrom::Start(start)).await.is_err() {
        return;
    }
    let mut remaining = body_len;
    let mut buf = vec![0u8; CHUNK];
    while remaining > 0 {
        let want = (remaining as usize).min(CHUNK);
        let n = match timeout(READ_TIMEOUT, stream.read(&mut buf[..want])).await {
            Ok(Ok(0)) | Ok(Err(_)) | Err(_) => break,
            Ok(Ok(n)) => n,
        };
        match timeout(WRITE_TIMEOUT, sock.write_all(&buf[..n])).await {
            Ok(Ok(())) => {}
            _ => break,
        }
        remaining -= n as u64;
    }
    let _ = sock.shutdown().await;
}

pub struct StreamServer {
    pub port: u16,
    task: JoinHandle<()>,
}

impl StreamServer {
    /// Must be called from inside the runtime (it binds a tokio socket).
    pub async fn start(session: Arc<Session>) -> std::io::Result<StreamServer> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let port = listener.local_addr()?.port();
        let task = tokio::spawn(async move {
            loop {
                match listener.accept().await {
                    Ok((sock, _)) => {
                        let session = session.clone();
                        tokio::spawn(handle_connection(sock, session));
                    }
                    Err(_) => tokio::time::sleep(Duration::from_millis(200)).await,
                }
            }
        });
        Ok(StreamServer { port, task })
    }

    pub fn stop(&self) {
        self.task.abort();
    }

    pub fn url(&self, id: &str, file: u32) -> String {
        format!("http://127.0.0.1:{}/stream/{}/{}", self.port, id, file)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn range_forms() {
        let len = 1000;
        assert_eq!(parse_range(None, len), RangeSpec::Full);
        assert_eq!(
            parse_range(Some("bytes=0-499"), len),
            RangeSpec::Partial { start: 0, end: 499 }
        );
        assert_eq!(
            parse_range(Some("bytes=500-"), len),
            RangeSpec::Partial { start: 500, end: 999 }
        );
        assert_eq!(
            parse_range(Some("bytes=-100"), len),
            RangeSpec::Partial { start: 900, end: 999 }
        );
        assert_eq!(
            parse_range(Some("bytes=-5000"), len),
            RangeSpec::Partial { start: 0, end: 999 }
        );
        assert_eq!(
            parse_range(Some("bytes=900-5000"), len),
            RangeSpec::Partial { start: 900, end: 999 }
        );
        assert_eq!(
            parse_range(Some("bytes=0-1,5-9"), len),
            RangeSpec::Partial { start: 0, end: 1 }
        );
    }

    #[test]
    fn range_edge_cases() {
        let len = 1000;
        assert_eq!(parse_range(Some("bytes=1000-"), len), RangeSpec::Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=-0"), len), RangeSpec::Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=9-3"), len), RangeSpec::Full);
        assert_eq!(parse_range(Some("items=0-3"), len), RangeSpec::Full);
        assert_eq!(parse_range(Some("bytes=abc"), len), RangeSpec::Full);
        assert_eq!(parse_range(Some("bytes=0-5"), 0), RangeSpec::Full);
    }

    #[test]
    fn request_head_parsing() {
        let h = parse_request_head(
            "GET /stream/0123456789abcdef0123456789abcdef01234567/2 HTTP/1.1\r\nHost: x\r\nrAnGe: bytes=5-\r\n",
        )
        .unwrap();
        assert_eq!(h.method, "GET");
        assert_eq!(h.range.as_deref(), Some("bytes=5-"));
        assert!(parse_request_head("garbage").is_none());
        assert!(parse_request_head("GET / SPDY/3\r\n").is_none());
    }

    #[test]
    fn stream_path_parsing() {
        let id = "0123456789ABCDEF0123456789abcdef01234567";
        assert_eq!(
            parse_stream_path(&format!("/stream/{id}/3")),
            Some((id.to_ascii_lowercase(), 3))
        );
        assert_eq!(
            parse_stream_path(&format!("/stream/{id}/0/movie.mkv?x=1")),
            Some((id.to_ascii_lowercase(), 0))
        );
        assert!(parse_stream_path("/stream/short/0").is_none());
        assert!(parse_stream_path(&format!("/other/{id}/0")).is_none());
        assert!(parse_stream_path(&format!("/stream/{id}/x")).is_none());
    }

    #[test]
    fn mime_types() {
        assert_eq!(mime_for_extension("MKV"), "video/x-matroska");
        assert_eq!(mime_for_extension("mp4"), "video/mp4");
        assert_eq!(mime_for_extension("zzz"), "application/octet-stream");
    }
}
