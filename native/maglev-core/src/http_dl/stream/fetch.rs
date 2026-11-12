//! Requests for streams, and AES-128 decryption.
//!
//! Every request goes through the same `reqwest::Client` as any other download (LAN rules, proxy, redirect limits,
//! read timeout). The cookie and the sign-in details are sent only to the host of the link the user gave; a segment
//! or key on another host gets the user agent and referer only.
//!
//! API checked against reqwest 0.13 (docs.rs/reqwest/0.13): `Client::get`, `RequestBuilder::{header, basic_auth,
//! send}`, `Response::{status, headers, url, content_length, chunk}`; and RustCrypto `cbc` 0.1.2 / `aes` 0.8.4
//! (docs.rs/cbc/0.1.2): `cbc::Decryptor<aes::Aes128>`, `KeyIvInit::new`, `BlockDecryptMut::decrypt_padded_vec_mut`
//! (feature `alloc`), `aes::cipher::block_padding::Pkcs7`.

use std::time::Duration;

use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
use reqwest::header::{ACCEPT_ENCODING, COOKIE, RANGE, REFERER, RETRY_AFTER, USER_AGENT};
use reqwest::Client;

use super::{StreamError, MAX_PLAYLIST_BYTES};

type Aes128CbcDec = cbc::Decryptor<aes::Aes128>;

/// What every request of one stream download needs. Lives in memory only.
#[derive(Clone)]
pub struct ReqCtx {
    pub client: Client,
    pub user_agent: Option<String>,
    pub referer: Option<String>,
    pub cookie: Option<String>,
    pub auth: Option<(String, String)>,
    /// Host of the link the user gave. The cookie and sign-in details go to this host only.
    pub origin_host: String,
}

#[derive(Debug)]
pub enum FetchFail {
    /// The server answered with this status (and maybe a `Retry-After`).
    Status(u16, Option<Duration>),
    /// The request could not be sent (DNS, connect, TLS, redirect policy). The caller reads the cause.
    Send(reqwest::Error),
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

fn host_lower(url: &str) -> String {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_ascii_lowercase()))
        .unwrap_or_default()
}

impl ReqCtx {
    /// A GET for `url`, with `Range` when `range` is `(offset, length)`.
    pub fn request(&self, url: &str, range: Option<(u64, u64)>) -> reqwest::RequestBuilder {
        let mut b = self.client.get(url).header(ACCEPT_ENCODING, "identity");
        if let Some(ua) = self.user_agent.as_deref().and_then(|v| reqwest::header::HeaderValue::from_str(v).ok()) {
            b = b.header(USER_AGENT, ua);
        }
        if let Some(r) = self.referer.as_deref().and_then(|v| reqwest::header::HeaderValue::from_str(v).ok()) {
            b = b.header(REFERER, r);
        }
        if host_lower(url) == self.origin_host.to_ascii_lowercase() {
            if let Some(c) = self.cookie.as_deref().and_then(|v| reqwest::header::HeaderValue::from_str(v).ok()) {
                b = b.header(COOKIE, c);
            }
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
    let resp = ctx.request(url, range).send().await.map_err(FetchFail::Send)?;
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
            cookie: Some("sid=1".into()),
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
}
