//! Redirects for every request a download makes (`NATIVE_CONTRACT.md` section 17, "Redirect cookies").
//!
//! The client's own policy never follows a redirect (`driver::build_client`): it refuses a hop onto the local network
//! and otherwise hands the 3xx answer back. `send_following` follows it here, so each hop carries the `Cookie` picked
//! for that hop's own host and the old host's cookie, and its sign-in details, never go along. `User-Agent`,
//! `Referer`, `Origin` and `Range` stay as they were. At most `MAX_HOPS` hops, and https to http is refused.
//!
//! API checked against reqwest 0.13 (docs.rs/reqwest/0.13): `Client::execute`, `RequestBuilder::build`,
//! `Request::{new, url, method, headers, headers_mut}`, `Response::{status, headers}`.

use std::fmt;

use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, COOKIE, LOCATION, PROXY_AUTHORIZATION};
use reqwest::{Client, Method, Request, StatusCode, Url};

use super::stream::fetch::{host_lower, pick_cookie};

/// How many redirects one request may follow.
pub const MAX_HOPS: usize = 10;

/// Why a request could not be sent or followed.
#[derive(Debug)]
pub enum SendError {
    /// reqwest could not send it (DNS, connect, TLS, or the client's local-network refusal). The source says which.
    Http(reqwest::Error),
    /// More than `MAX_HOPS` redirects.
    TooManyHops,
    /// A redirect from https to http.
    Downgrade,
    /// A `Location` that is not a http(s) link.
    BadLocation,
}

impl fmt::Display for SendError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SendError::Http(_) => f.write_str("the request could not be sent"),
            SendError::TooManyHops => f.write_str("too many redirects"),
            SendError::Downgrade => f.write_str("redirect from https to http"),
            SendError::BadLocation => f.write_str("redirect to a link that is not http or https"),
        }
    }
}

impl std::error::Error for SendError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            SendError::Http(e) => Some(e),
            _ => None,
        }
    }
}

/// Which cookie goes to which host: the `Cookies` entries of the in-app browser jar (longest domain match), else the
/// link's own `Cookie` when the host is the host of the link the user gave.
#[derive(Debug, Clone, Default)]
pub struct CookiePicker {
    pub host_cookies: Vec<(String, String)>,
    pub link_cookie: Option<String>,
    pub link_host: String,
}

impl CookiePicker {
    pub fn for_host(&self, host: &str) -> Option<HeaderValue> {
        pick_cookie(&self.host_cookies, self.link_cookie.as_deref(), &self.link_host, host)
            .and_then(|c| HeaderValue::from_str(c).ok())
    }

    /// A picker for a link: `link_host` comes from its URL.
    pub fn for_link(link_url: &str, link_cookie: Option<&str>, host_cookies: &[(String, String)]) -> Self {
        Self {
            host_cookies: host_cookies.to_vec(),
            link_cookie: link_cookie.map(str::to_string),
            link_host: host_lower(link_url),
        }
    }
}

/// The method of the next hop: 303 is always a GET (a HEAD stays a HEAD); 301 and 302 turn a POST into a GET;
/// 307 and 308 keep the method.
pub fn hop_method(status: StatusCode, method: &Method) -> Method {
    match status.as_u16() {
        303 if *method != Method::HEAD => Method::GET,
        301 | 302 if *method == Method::POST => Method::GET,
        _ => method.clone(),
    }
}

/// True for the answers that carry a hop.
fn is_redirect(status: StatusCode) -> bool {
    matches!(status.as_u16(), 301 | 302 | 303 | 307 | 308)
}

/// The headers of the next hop: everything the last request had, except that the old host's cookie never goes along
/// (the new host's own cookie is picked) and sign-in details stay on the host they were given for.
pub fn hop_headers(prev: &HeaderMap, from: &Url, to: &Url, picker: &CookiePicker) -> HeaderMap {
    let mut h = prev.clone();
    h.remove(COOKIE);
    let same_origin = from.host_str() == to.host_str() && from.port_or_known_default() == to.port_or_known_default();
    if !same_origin {
        h.remove(AUTHORIZATION);
        h.remove(PROXY_AUTHORIZATION);
    }
    if let Some(c) = picker.for_host(&to.host_str().unwrap_or("").to_ascii_lowercase()) {
        h.insert(COOKIE, c);
    }
    h
}

/// The request for the next hop, or `Ok(None)` when `status` is not a redirect with a `Location`.
pub fn next_request(
    status: StatusCode,
    location: Option<&str>,
    prev: &Request,
    hops_so_far: usize,
    picker: &CookiePicker,
) -> Result<Option<Request>, SendError> {
    let Some(loc) = location.filter(|_| is_redirect(status)) else {
        return Ok(None);
    };
    if hops_so_far >= MAX_HOPS {
        return Err(SendError::TooManyHops);
    }
    // A relative `Location` is resolved against the URL that answered.
    let next = prev.url().join(loc.trim()).map_err(|_| SendError::BadLocation)?;
    if next.scheme() != "http" && next.scheme() != "https" {
        return Err(SendError::BadLocation);
    }
    if prev.url().scheme() == "https" && next.scheme() == "http" {
        return Err(SendError::Downgrade);
    }
    let method = hop_method(status, prev.method());
    let headers = hop_headers(prev.headers(), prev.url(), &next, picker);
    let mut req = Request::new(method, next);
    *req.headers_mut() = headers;
    Ok(Some(req))
}

/// Sends `first` and follows its redirects by hand (see the module docs). The final response is the last hop's, so
/// `Response::url()` is the last hop's link.
pub async fn send_following(
    client: &Client,
    first: reqwest::RequestBuilder,
    picker: &CookiePicker,
) -> Result<reqwest::Response, SendError> {
    let mut req = first.build().map_err(SendError::Http)?;
    let mut hops = 0usize;
    loop {
        // Kept for the next hop; the request itself is consumed by `execute`. Our requests have no body.
        let sent = {
            let mut c = Request::new(req.method().clone(), req.url().clone());
            *c.headers_mut() = req.headers().clone();
            c
        };
        let resp = client.execute(req).await.map_err(SendError::Http)?;
        let location = resp.headers().get(LOCATION).and_then(|v| v.to_str().ok()).map(str::to_string);
        match next_request(resp.status(), location.as_deref(), &sent, hops, picker)? {
            Some(next) => {
                req = next;
                hops += 1;
            }
            None => return Ok(resp),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::{ORIGIN, RANGE, REFERER, USER_AGENT};

    fn picker() -> CookiePicker {
        CookiePicker::for_link(
            "https://page.test/v/1",
            Some("sid=1"),
            &[("cdn.test".to_string(), "c=1".to_string())],
        )
    }

    fn get(url: &str) -> Request {
        let mut r = Request::new(Method::GET, Url::parse(url).unwrap());
        let h = r.headers_mut();
        h.insert(COOKIE, HeaderValue::from_static("sid=1"));
        h.insert(USER_AGENT, HeaderValue::from_static("UA"));
        h.insert(REFERER, HeaderValue::from_static("https://page.test/v/1"));
        h.insert(ORIGIN, HeaderValue::from_static("https://page.test"));
        h.insert(RANGE, HeaderValue::from_static("bytes=5-"));
        h.insert(AUTHORIZATION, HeaderValue::from_static("Basic abc"));
        r
    }

    fn step(prev: &Request, status: u16, loc: &str, hops: usize) -> Result<Option<Request>, SendError> {
        next_request(StatusCode::from_u16(status).unwrap(), Some(loc), prev, hops, &picker())
    }

    fn cookie(r: &Request) -> Option<String> {
        r.headers().get(COOKIE).map(|v| v.to_str().unwrap().to_string())
    }

    #[test]
    fn each_hop_carries_the_cookie_of_its_own_host_and_never_the_old_one() {
        let first = get("https://page.test/v/1");
        let second = step(&first, 302, "https://cdn.test/f", 0).unwrap().unwrap();
        assert_eq!(cookie(&second).as_deref(), Some("c=1"));
        assert!(second.headers().get(AUTHORIZATION).is_none());
        // The next host has no entry: no cookie at all, not the first host's and not the CDN's.
        let third = step(&second, 302, "https://seg.cdn.test/f", 1).unwrap().unwrap();
        assert_eq!(cookie(&third).as_deref(), Some("c=1"));
        let fourth = step(&third, 302, "https://other.test/f", 2).unwrap().unwrap();
        assert_eq!(cookie(&fourth), None);
        // Back on the link's host: its own cookie again.
        let back = step(&fourth, 302, "https://page.test/x", 3).unwrap().unwrap();
        assert_eq!(cookie(&back).as_deref(), Some("sid=1"));
    }

    #[test]
    fn a_lookalike_host_gets_no_cookie() {
        let first = get("https://page.test/v/1");
        let next = step(&first, 302, "https://evilcdn.test/f", 0).unwrap().unwrap();
        assert_eq!(cookie(&next), None);
    }

    #[test]
    fn user_agent_referer_origin_and_range_stay() {
        let first = get("https://page.test/v/1");
        let next = step(&first, 307, "https://cdn.test/f", 0).unwrap().unwrap();
        assert_eq!(next.headers().get(USER_AGENT).unwrap(), "UA");
        assert_eq!(next.headers().get(REFERER).unwrap(), "https://page.test/v/1");
        assert_eq!(next.headers().get(ORIGIN).unwrap(), "https://page.test");
        assert_eq!(next.headers().get(RANGE).unwrap(), "bytes=5-");
    }

    #[test]
    fn the_sign_in_stays_on_a_same_origin_hop() {
        let first = get("https://page.test/v/1");
        let next = step(&first, 302, "/other", 0).unwrap().unwrap();
        assert_eq!(next.url().as_str(), "https://page.test/other");
        assert!(next.headers().get(AUTHORIZATION).is_some());
        assert_eq!(cookie(&next).as_deref(), Some("sid=1"));
    }

    #[test]
    fn a_relative_location_is_resolved_against_the_answering_url() {
        let first = get("https://page.test/a/b/c");
        assert_eq!(step(&first, 301, "d", 0).unwrap().unwrap().url().as_str(), "https://page.test/a/b/d");
        assert_eq!(step(&first, 301, "../x?y=1", 0).unwrap().unwrap().url().as_str(), "https://page.test/a/x?y=1");
        assert_eq!(step(&first, 301, "//cdn.test/z", 0).unwrap().unwrap().url().as_str(), "https://cdn.test/z");
    }

    #[test]
    fn the_cap_is_ten_hops() {
        let first = get("https://page.test/v/1");
        assert!(step(&first, 302, "/n", MAX_HOPS - 1).unwrap().is_some());
        assert!(matches!(step(&first, 302, "/n", MAX_HOPS), Err(SendError::TooManyHops)));
    }

    #[test]
    fn https_to_http_and_odd_schemes_are_refused() {
        let first = get("https://page.test/v/1");
        assert!(matches!(step(&first, 302, "http://cdn.test/f", 0), Err(SendError::Downgrade)));
        assert!(matches!(step(&first, 302, "ftp://cdn.test/f", 0), Err(SendError::BadLocation)));
        let plain = get("http://page.test/v/1");
        assert!(step(&plain, 302, "https://cdn.test/f", 0).unwrap().is_some());
    }

    #[test]
    fn only_a_redirect_with_a_location_is_followed() {
        let first = get("https://page.test/v/1");
        assert!(step(&first, 200, "/x", 0).unwrap().is_none());
        assert!(step(&first, 304, "/x", 0).unwrap().is_none());
        assert!(next_request(StatusCode::FOUND, None, &first, 0, &picker()).unwrap().is_none());
    }

    #[test]
    fn methods_follow_the_status() {
        assert_eq!(hop_method(StatusCode::SEE_OTHER, &Method::POST), Method::GET);
        assert_eq!(hop_method(StatusCode::SEE_OTHER, &Method::GET), Method::GET);
        assert_eq!(hop_method(StatusCode::SEE_OTHER, &Method::HEAD), Method::HEAD);
        assert_eq!(hop_method(StatusCode::FOUND, &Method::POST), Method::GET);
        assert_eq!(hop_method(StatusCode::MOVED_PERMANENTLY, &Method::POST), Method::GET);
        assert_eq!(hop_method(StatusCode::TEMPORARY_REDIRECT, &Method::POST), Method::POST);
        assert_eq!(hop_method(StatusCode::PERMANENT_REDIRECT, &Method::GET), Method::GET);
        let first = get("https://page.test/v/1");
        assert_eq!(step(&first, 303, "https://cdn.test/f", 0).unwrap().unwrap().method(), Method::GET);
    }
}

/// The same code over real sockets, through the client the downloads use (`driver::build_client`): the client's policy
/// only refuses the local network, and `send_following` does the following.
#[cfg(test)]
mod wire {
    use super::*;
    use crate::http_dl::driver::build_client;
    use crate::http_dl::rules::LanScope;
    use parking_lot::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// What a test server saw of one request.
    #[derive(Debug, Clone)]
    struct Seen {
        cookie: Option<String>,
    }

    type Log = Arc<Mutex<Vec<Seen>>>;

    fn redirect_to(status: &str, loc: &str) -> String {
        format!("HTTP/1.1 {status}\r\nLocation: {loc}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
    }

    fn ok(body: &str) -> String {
        format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())
    }

    /// A server on 127.0.0.1 answering each request with `handler(path, cookie)`.
    async fn serve(handler: impl Fn(&str, Option<&str>) -> String + Send + Sync + 'static) -> (u16, Log) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let log: Log = Arc::new(Mutex::new(Vec::new()));
        let (log2, handler) = (log.clone(), Arc::new(handler));
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { return };
                let (log, handler) = (log2.clone(), handler.clone());
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    let mut tmp = [0u8; 2048];
                    while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                        match sock.read(&mut tmp).await {
                            Ok(0) | Err(_) => return,
                            Ok(n) => buf.extend_from_slice(&tmp[..n]),
                        }
                    }
                    let text = String::from_utf8_lossy(&buf).into_owned();
                    let path = text.split_whitespace().nth(1).unwrap_or("").to_string();
                    let cookie = text.lines().find_map(|l| {
                        let (k, v) = l.split_once(':')?;
                        k.trim().eq_ignore_ascii_case("cookie").then(|| v.trim().to_string())
                    });
                    log.lock().push(Seen { cookie: cookie.clone() });
                    let _ = sock.write_all(handler(&path, cookie.as_deref()).as_bytes()).await;
                    let _ = sock.shutdown().await;
                });
            }
        });
        (port, log)
    }

    fn picker(entries: &[(&str, &str)]) -> CookiePicker {
        let hc: Vec<(String, String)> = entries.iter().map(|(h, c)| (h.to_string(), c.to_string())).collect();
        CookiePicker::for_link("http://127.0.0.1/", Some("sid=1"), &hc)
    }

    fn chain_says(e: &(dyn std::error::Error + 'static), needle: &str) -> bool {
        let mut cur: Option<&(dyn std::error::Error + 'static)> = Some(e);
        while let Some(x) = cur {
            if x.to_string().contains(needle) {
                return true;
            }
            cur = x.source();
        }
        false
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_second_host_gets_its_own_cookie_and_never_the_first_hosts() {
        // "Host" one is 127.0.0.1, "host" two is localhost (another name, so another cookie).
        let (pb, log_b) =
            serve(|_, c| if c == Some("c=1") { ok("hello") } else { redirect_to("403 Forbidden", "/") }).await;
        let (pa, log_a) = serve(move |_, _| redirect_to("303 See Other", &format!("http://localhost:{pb}/real.bin"))).await;
        let client = build_client(None, LanScope::LanOrigin).unwrap();
        let first = client.get(format!("http://127.0.0.1:{pa}/f")).header(COOKIE, "sid=1");
        let resp = send_following(&client, first, &picker(&[("localhost", "c=1")])).await.unwrap();
        assert_eq!(resp.status().as_u16(), 200);
        // final_url is the last hop.
        assert_eq!(resp.url().as_str(), format!("http://localhost:{pb}/real.bin"));
        assert_eq!(resp.text().await.unwrap(), "hello");
        assert_eq!(log_a.lock()[0].cookie.as_deref(), Some("sid=1"));
        let seen = log_b.lock();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].cookie.as_deref(), Some("c=1"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_host_with_no_entry_gets_no_cookie_at_all() {
        let (pb, log_b) = serve(|_, _| ok("x")).await;
        let (pa, _) = serve(move |_, _| redirect_to("302 Found", &format!("http://localhost:{pb}/x"))).await;
        let client = build_client(None, LanScope::LanOrigin).unwrap();
        let first = client.get(format!("http://127.0.0.1:{pa}/f")).header(COOKIE, "sid=1");
        send_following(&client, first, &picker(&[])).await.unwrap();
        assert_eq!(log_b.lock()[0].cookie, None);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_relative_location_is_followed_on_the_same_host_with_its_cookie() {
        let (pa, log) = serve(|path, _| match path {
            "/a/b" => redirect_to("301 Moved Permanently", "../c"),
            "/c" => ok("done"),
            _ => redirect_to("404 Not Found", "/"),
        })
        .await;
        let client = build_client(None, LanScope::LanOrigin).unwrap();
        let first = client.get(format!("http://127.0.0.1:{pa}/a/b")).header(COOKIE, "sid=1");
        let resp = send_following(&client, first, &picker(&[])).await.unwrap();
        assert_eq!(resp.url().path(), "/c");
        assert_eq!(log.lock()[1].cookie.as_deref(), Some("sid=1"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_eleventh_redirect_is_an_error() {
        let count = Arc::new(AtomicUsize::new(0));
        let c2 = count.clone();
        let (pa, _) = serve(move |_, _| {
            c2.fetch_add(1, Ordering::SeqCst);
            redirect_to("302 Found", "/again")
        })
        .await;
        let client = build_client(None, LanScope::LanOrigin).unwrap();
        let first = client.get(format!("http://127.0.0.1:{pa}/start"));
        let err = send_following(&client, first, &picker(&[])).await.unwrap_err();
        assert!(matches!(err, SendError::TooManyHops), "{err:?}");
        // The first request and ten hops.
        assert_eq!(count.load(Ordering::SeqCst), MAX_HOPS + 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn ten_redirects_are_still_followed() {
        let (pa, _) = serve(|path, _| {
            let n: usize = path.trim_start_matches("/h").parse().unwrap_or(0);
            if n >= MAX_HOPS {
                ok("end")
            } else {
                redirect_to("302 Found", &format!("/h{}", n + 1))
            }
        })
        .await;
        let client = build_client(None, LanScope::LanOrigin).unwrap();
        let resp = send_following(&client, client.get(format!("http://127.0.0.1:{pa}/h0")), &picker(&[])).await.unwrap();
        assert_eq!(resp.url().path(), "/h10");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_redirect_onto_the_local_network_is_still_refused_from_a_public_link() {
        // The first request goes to a literal address (no lookup); what matters is the hop.
        for target in ["http://localhost:9/x", "http://192.168.1.1/x", "http://router.local/x"] {
            let t = target.to_string();
            let (pa, _) = serve(move |_, _| redirect_to("302 Found", &t)).await;
            let client = build_client(None, LanScope::Public).unwrap();
            let first = client.get(format!("http://127.0.0.1:{pa}/f"));
            let err = send_following(&client, first, &picker(&[])).await.unwrap_err();
            assert!(chain_says(&err, "redirect to a device on the local network"), "{target}: {err:?}");
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_local_link_may_redirect_locally() {
        let (pb, _) = serve(|_, _| ok("x")).await;
        let (pa, _) = serve(move |_, _| redirect_to("307 Temporary Redirect", &format!("http://localhost:{pb}/x"))).await;
        let client = build_client(None, LanScope::LanOrigin).unwrap();
        let resp = send_following(&client, client.get(format!("http://127.0.0.1:{pa}/f")), &picker(&[])).await.unwrap();
        assert_eq!(resp.status().as_u16(), 200);
    }
}
