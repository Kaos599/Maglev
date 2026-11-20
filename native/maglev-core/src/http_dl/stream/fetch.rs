//! Requests for streams, and AES-128 decryption.
//!
//! Every request goes through the same `reqwest::Client` as any other download (LAN rules, proxy, redirect limits,
//! read timeout). Every request carries the user agent, the referer and the origin. The sign-in details go only to
//! the host of the link the user gave. A cookie goes to the host it belongs to: the one the app read from the
//! WebView jar for that host (`host_cookies`, or a parent domain of it), and the playlist link's own cookie for the
//! playlist host. A segment or key on a host the app sent no cookie for gets none.
//!
//! API checked against reqwest 0.13 (docs.rs/reqwest/0.13): `Client::get`, `RequestBuilder::{header, basic_auth,
//! send}`, `Response::{status, headers, url, content_length, chunk}`; and RustCrypto `cbc` 0.1.2 / `aes` 0.8.4
//! (docs.rs/cbc/0.1.2): `cbc::Decryptor<aes::Aes128>`, `KeyIvInit::new`, `BlockDecryptMut::decrypt_padded_vec_mut`
//! (feature `alloc`), `aes::cipher::block_padding::Pkcs7`.

use std::time::Duration;

use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
use reqwest::header::{ACCEPT_ENCODING, COOKIE, ORIGIN, RANGE, REFERER, RETRY_AFTER, USER_AGENT};
use reqwest::Client;

use super::{StreamError, MAX_PLAYLIST_BYTES};
use crate::http_dl::redirect::{send_following, CookiePicker, SendError};

type Aes128CbcDec = cbc::Decryptor<aes::Aes128>;

/// What every request of one stream download needs. Lives in memory only.
#[derive(Clone)]
pub struct ReqCtx {
    pub client: Client,
    pub user_agent: Option<String>,
    pub referer: Option<String>,
    /// The `Origin` of the page (scheme and host). Sent on every request.
    pub origin: Option<String>,
    /// The cookie of the playlist link. Goes to the playlist host.
    pub cookie: Option<String>,
    /// Cookies the app read from the WebView jar, one entry per host it knows (page, playlist, key and segment hosts).
    pub host_cookies: Vec<(String, String)>,
    pub auth: Option<(String, String)>,
    /// Host of the link the user gave. The cookie and sign-in details go to this host only.
    pub origin_host: String,
}

#[derive(Debug)]
pub enum FetchFail {
    /// The server answered with this status (and maybe a `Retry-After`).
    Status(u16, Option<Duration>),
    /// The request could not be sent (DNS, connect, TLS, redirect policy). The caller reads the cause.
    Send(SendError),
    /// The body broke off.
    Body(reqwest::Error),
    /// The body ended before the promised length.
    Short,
    /// The body is bigger than the limit.
    TooBig,
    /// A range was asked for and the server sent the whole file.
    RangeIgnored,
    /// The caller's sink failed (disk).
    Sink(std::io::Error),
}

pub(crate) fn host_lower(url: &str) -> String {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_ascii_lowercase()))
        .unwrap_or_default()
}

/// True when `host` is `domain` or a subdomain of it.
pub(crate) fn host_in_domain(host: &str, domain: &str) -> bool {
    !domain.is_empty() && (host == domain || host.ends_with(&format!(".{domain}")))
}

/// The cookie for a request to `host`: the entry of the longest matching domain in `host_cookies`, else the link's own
/// cookie when `host` is `link_host`. Never a cookie that belongs to another host, so a redirect to a new host asks
/// again with the new host and the old host's cookie does not follow it. Shared by streams and direct files.
pub(crate) fn pick_cookie<'a>(
    host_cookies: &'a [(String, String)],
    link_cookie: Option<&'a str>,
    link_host: &str,
    host: &str,
) -> Option<&'a str> {
    let host = host.to_ascii_lowercase();
    let mut best: Option<(&str, usize)> = None;
    for (h, c) in host_cookies {
        let h = h.trim_start_matches('.').to_ascii_lowercase();
        if c.is_empty() || !host_in_domain(&host, &h) {
            continue;
        }
        if best.map(|(_, n)| h.len() > n).unwrap_or(true) {
            best = Some((c.as_str(), h.len()));
        }
    }
    if let Some((c, _)) = best {
        return Some(c);
    }
    if host == link_host.to_ascii_lowercase() {
        return link_cookie;
    }
    None
}

impl ReqCtx {
    /// The cookie for a request to `host`: the entry of the nearest matching domain, else the playlist link's
    /// cookie when `host` is the playlist host. Never a cookie that belongs to an unrelated host.
    pub fn cookie_for(&self, host: &str) -> Option<&str> {
        pick_cookie(&self.host_cookies, self.cookie.as_deref(), &self.origin_host, host)
    }

    /// `request`, sent; its redirects are followed here so each hop gets the cookie of its own host.
    pub async fn send(&self, url: &str, range: Option<(u64, u64)>) -> Result<reqwest::Response, SendError> {
        let picker = CookiePicker {
            host_cookies: self.host_cookies.clone(),
            link_cookie: self.cookie.clone(),
            link_host: self.origin_host.clone(),
        };
        send_following(&self.client, self.request(url, range), &picker).await
    }

    /// A GET for `url`, with `Range` when `range` is `(offset, length)`.
    pub fn request(&self, url: &str, range: Option<(u64, u64)>) -> reqwest::RequestBuilder {
        let mut b = self.client.get(url).header(ACCEPT_ENCODING, "identity");
        if let Some(ua) = self.user_agent.as_deref().and_then(|v| reqwest::header::HeaderValue::from_str(v).ok()) {
            b = b.header(USER_AGENT, ua);
        }
        if let Some(r) = self.referer.as_deref().and_then(|v| reqwest::header::HeaderValue::from_str(v).ok()) {
            b = b.header(REFERER, r);
        }
        if let Some(o) = self.origin.as_deref().and_then(|v| reqwest::header::HeaderValue::from_str(v).ok()) {
            b = b.header(ORIGIN, o);
        }
        let host = host_lower(url);
        if let Some(c) = self.cookie_for(&host).and_then(|v| reqwest::header::HeaderValue::from_str(v).ok()) {
            b = b.header(COOKIE, c);
        }
        if host == self.origin_host.to_ascii_lowercase() {
            if let Some((u, p)) = &self.auth {
                b = b.basic_auth(u, Some(p));
            }
        }
        if let Some((off, len)) = range {
            b = b.header(RANGE, format!("bytes={}-{}", off, off + len.saturating_sub(1)));
        }
        b
    }
}

fn retry_after(resp: &reqwest::Response) -> Option<Duration> {
    let v = resp.headers().get(RETRY_AFTER)?.to_str().ok()?;
    super::super::rules::parse_retry_after(Some(v))
}

/// Sends the request and checks the status. `Ok` means 200, or 206 when a range was asked.
async fn open(ctx: &ReqCtx, url: &str, range: Option<(u64, u64)>) -> Result<reqwest::Response, FetchFail> {
    let resp = ctx.send(url, range).await.map_err(FetchFail::Send)?;
    let status = resp.status().as_u16();
    match (status, range.is_some()) {
        (206, true) | (200, false) => Ok(resp),
        (200, true) | (206, false) => Err(FetchFail::RangeIgnored),
        _ => Err(FetchFail::Status(status, retry_after(&resp))),
    }
}

/// The whole body in memory, at most `cap` bytes.
pub async fn fetch_vec(ctx: &ReqCtx, url: &str, range: Option<(u64, u64)>, cap: u64) -> Result<Vec<u8>, FetchFail> {
    let mut resp = open(ctx, url, range).await?;
    let promised = range.map(|(_, l)| l).or_else(|| resp.content_length());
    if promised.map(|p| p > cap).unwrap_or(false) {
        return Err(FetchFail::TooBig);
    }
    let mut out: Vec<u8> = Vec::with_capacity(promised.unwrap_or(0).min(cap) as usize);
    while let Some(chunk) = resp.chunk().await.map_err(FetchFail::Body)? {
        if (out.len() + chunk.len()) as u64 > cap {
            return Err(FetchFail::TooBig);
        }
        out.extend_from_slice(&chunk);
    }
    if let Some(p) = promised {
        if (out.len() as u64) != p {
            return Err(FetchFail::Short);
        }
    }
    Ok(out)
}

/// A playlist as text (at most 2 MB) and the link it ended up at after redirects.
pub async fn fetch_text(ctx: &ReqCtx, url: &str) -> Result<(String, String), FetchFail> {
    let mut resp = open(ctx, url, None).await?;
    let final_url = resp.url().to_string();
    if resp.content_length().map(|l| l > MAX_PLAYLIST_BYTES).unwrap_or(false) {
        return Err(FetchFail::TooBig);
    }
    let mut out: Vec<u8> = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(FetchFail::Body)? {
        if (out.len() + chunk.len()) as u64 > MAX_PLAYLIST_BYTES {
            return Err(FetchFail::TooBig);
        }
        out.extend_from_slice(&chunk);
    }
    Ok((String::from_utf8_lossy(&out).into_owned(), final_url))
}

/// AES-128-CBC with PKCS#7 padding (HLS `METHOD=AES-128`, whole segment). A length that is not a multiple of 16, or
/// bad padding, is `STREAM_UNSUPPORTED`.
pub fn decrypt_aes128_cbc(key: &[u8; 16], iv: &[u8; 16], data: &[u8]) -> Result<Vec<u8>, StreamError> {
    Aes128CbcDec::new(&(*key).into(), &(*iv).into())
        .decrypt_padded_vec_mut::<Pkcs7>(data)
        .map_err(|_| StreamError::Unsupported)
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes::cipher::{block_padding::NoPadding, BlockEncryptMut};

    type Aes128CbcEnc = cbc::Encryptor<aes::Aes128>;

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }

    fn arr(v: Vec<u8>) -> [u8; 16] {
        let mut a = [0u8; 16];
        a.copy_from_slice(&v);
        a
    }

    #[test]
    fn nist_sp800_38a_cbc_aes128_block() {
        // NIST SP 800-38A, F.2.1 CBC-AES128.Encrypt, block 1 (no padding).
        let key = arr(hex("2b7e151628aed2a6abf7158809cf4f3c"));
        let iv = arr(hex("000102030405060708090a0b0c0d0e0f"));
        let plain = hex("6bc1bee22e409f96e93d7e117393172a");
        let cipher = hex("7649abac8119b246cee98e9b12e9197d");
        let dec = Aes128CbcDec::new(&key.into(), &iv.into()).decrypt_padded_vec_mut::<NoPadding>(&cipher).unwrap();
        assert_eq!(dec, plain);
        let enc = Aes128CbcEnc::new(&key.into(), &iv.into()).encrypt_padded_vec_mut::<NoPadding>(&plain);
        assert_eq!(enc, cipher);
    }

    #[test]
    fn round_trips_a_padded_segment() {
        let key = [7u8; 16];
        let iv = super::super::hls::iv_from_sequence(42);
        for len in [0usize, 1, 15, 16, 17, 188 * 10, 5000] {
            let plain: Vec<u8> = (0..len).map(|i| (i % 251) as u8).collect();
            let enc = Aes128CbcEnc::new(&key.into(), &iv.into()).encrypt_padded_vec_mut::<Pkcs7>(&plain);
            assert_eq!(enc.len() % 16, 0);
            assert_eq!(decrypt_aes128_cbc(&key, &iv, &enc).unwrap(), plain, "len {len}");
        }
    }

    #[test]
    fn a_wrong_key_or_iv_does_not_give_the_plaintext() {
        let key = [1u8; 16];
        let iv = [2u8; 16];
        let plain = vec![9u8; 100];
        let enc = Aes128CbcEnc::new(&key.into(), &iv.into()).encrypt_padded_vec_mut::<Pkcs7>(&plain);
        let wrong = decrypt_aes128_cbc(&[3u8; 16], &iv, &enc);
        assert!(wrong.is_err() || wrong.unwrap() != plain);
    }

    #[test]
    fn bad_padding_or_length_is_unsupported() {
        let key = arr(hex("2b7e151628aed2a6abf7158809cf4f3c"));
        let iv = arr(hex("000102030405060708090a0b0c0d0e0f"));
        // This block decrypts to the NIST plaintext, whose last byte (0x2a) is not valid PKCS#7 padding.
        let cipher = hex("7649abac8119b246cee98e9b12e9197d");
        assert_eq!(decrypt_aes128_cbc(&key, &iv, &cipher), Err(StreamError::Unsupported));
        assert_eq!(decrypt_aes128_cbc(&key, &iv, &cipher[..15]), Err(StreamError::Unsupported));
        assert_eq!(decrypt_aes128_cbc(&key, &iv, &[]), Err(StreamError::Unsupported));
    }

    #[test]
    fn credentials_go_to_the_origin_host_only() {
        let ctx = ReqCtx {
            client: Client::new(),
            user_agent: Some("UA".into()),
            referer: Some("https://page.test/".into()),
            origin: None,
            cookie: Some("sid=1".into()),
            host_cookies: Vec::new(),
            auth: Some(("u".into(), "p".into())),
            origin_host: "cdn.test".into(),
        };
        let same = ctx.request("https://cdn.test/a.ts", None).build().unwrap();
        assert!(same.headers().get(COOKIE).is_some());
        assert!(same.headers().get(reqwest::header::AUTHORIZATION).is_some());
        let other = ctx.request("https://other.test/a.ts", Some((10, 20))).build().unwrap();
        assert!(other.headers().get(COOKIE).is_none());
        assert!(other.headers().get(reqwest::header::AUTHORIZATION).is_none());
        assert!(other.headers().get(USER_AGENT).is_some());
        assert_eq!(other.headers().get(RANGE).unwrap(), "bytes=10-29");
    }

    fn ctx_with(host_cookies: &[(&str, &str)]) -> ReqCtx {
        ReqCtx {
            client: Client::new(),
            user_agent: Some("UA".into()),
            referer: Some("https://page.test/v/1".into()),
            origin: Some("https://page.test".into()),
            cookie: Some("playlist=1".into()),
            host_cookies: host_cookies.iter().map(|(h, c)| (h.to_string(), c.to_string())).collect(),
            auth: None,
            origin_host: "cdn.test".into(),
        }
    }

    fn cookie_of(ctx: &ReqCtx, url: &str) -> Option<String> {
        ctx.request(url, None).build().unwrap().headers().get(COOKIE).map(|v| v.to_str().unwrap().to_string())
    }

    #[test]
    fn every_request_carries_referer_origin_and_user_agent() {
        let ctx = ctx_with(&[]);
        for url in ["https://cdn.test/a.m3u8", "https://keys.other.test/k", "https://seg.third.test/1.ts"] {
            let req = ctx.request(url, None).build().unwrap();
            assert_eq!(req.headers().get(REFERER).unwrap(), "https://page.test/v/1", "{url}");
            assert_eq!(req.headers().get(ORIGIN).unwrap(), "https://page.test", "{url}");
            assert_eq!(req.headers().get(USER_AGENT).unwrap(), "UA", "{url}");
        }
    }

    #[test]
    fn each_host_gets_its_own_cookie() {
        let ctx = ctx_with(&[("cdn.test", "a=1"), ("keys.other.test", "k=2"), ("third.test", "t=3")]);
        // An exact entry wins over the playlist link's own cookie.
        assert_eq!(cookie_of(&ctx, "https://cdn.test/a.m3u8").as_deref(), Some("a=1"));
        assert_eq!(cookie_of(&ctx, "https://keys.other.test/key").as_deref(), Some("k=2"));
        // A subdomain takes the cookie of its parent domain, not of a sibling or a look-alike.
        assert_eq!(cookie_of(&ctx, "https://seg7.third.test/1.ts").as_deref(), Some("t=3"));
        assert_eq!(cookie_of(&ctx, "https://other.test/1.ts"), None);
        assert_eq!(cookie_of(&ctx, "https://evilthird.test/1.ts"), None);
    }

    #[test]
    fn playlist_cookie_goes_to_the_playlist_host_only_and_nearest_domain_wins() {
        let ctx = ctx_with(&[("test", "wide=1"), ("seg.test", "narrow=2")]);
        assert_eq!(cookie_of(&ctx, "https://a.seg.test/1.ts").as_deref(), Some("narrow=2"));
        assert_eq!(cookie_of(&ctx, "https://x.test/1.ts").as_deref(), Some("wide=1"));
        let ctx = ctx_with(&[]);
        assert_eq!(cookie_of(&ctx, "https://cdn.test/a.m3u8").as_deref(), Some("playlist=1"));
        assert_eq!(cookie_of(&ctx, "https://other.test/1.ts"), None);
    }
}
