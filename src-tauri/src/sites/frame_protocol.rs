use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::Engine;
use rand::RngCore;

const MAX_CONNECTIONS: usize = 64;
const MAX_HEAD: usize = 8192;
const IO_TIMEOUT: Duration = Duration::from_secs(5);

/// Staged documents kept at once; the oldest goes first. NFT grids mount one frame per tile.
const MAX_DOCS: usize = 96;

/// A living NFT runs its own inline code and reaches nothing: chain data comes only through the
/// read-only postMessage bridge the host answers.
const NFT_CSP: &str = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; \
img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; \
base-uri 'none'; form-action 'none'";

/// A chain-state living NFT is the same, except that it may read one JSON-RPC endpoint: the one of
/// the network its token lives on, for read-only contract_call.
const CHAIN_CSP_HEAD: &str = "default-src 'none'; script-src 'unsafe-inline'; \
style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; \
base-uri 'none'; form-action 'none'; connect-src ";

/// Hosts a program may never reach, whatever the caller asks: the 0xio proxy carries our key.
const BLOCKED_HOSTS: &[&str] = &["rpc-proxy.0xio.xyz"];

/// An http(s) endpoint with no userinfo, query or fragment, made only of characters that are safe
/// inside a CSP source list. Anything else is refused, and the frame gets no network at all.
fn rpc_source(endpoint: &str) -> Option<&str> {
    let rest = endpoint
        .strip_prefix("https://")
        .or_else(|| endpoint.strip_prefix("http://"))?;
    let host_port = rest.split('/').next().unwrap_or("");
    let host = host_port
        .split(':')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    let safe = rest
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b".-:/_~".contains(&b));
    let port_ok = match host_port.split_once(':') {
        Some((_, port)) => {
            !port.is_empty() && port.len() <= 5 && port.bytes().all(|b| b.is_ascii_digit())
        }
        None => true,
    };
    let host_ok = !host.is_empty()
        && !host.starts_with('.')
        && !host.ends_with('.')
        && host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-');
    if safe && port_ok && host_ok && !BLOCKED_HOSTS.contains(&host.as_str()) {
        Some(endpoint)
    } else {
        None
    }
}

fn chain_csp(endpoint: Option<&str>) -> String {
    format!(
        "{CHAIN_CSP_HEAD}{}",
        endpoint.and_then(rpc_source).unwrap_or("'none'")
    )
}

/// An oct:// page may load https resources as a web page does, but frames nothing and can never
/// load anything over plain http.
const PAGE_CSP: &str = "default-src 'none'; script-src 'unsafe-inline' data: https:; \
style-src 'unsafe-inline' https:; img-src data: blob: https:; media-src data: blob: https:; \
font-src data: https:; connect-src https: wss:; frame-src 'none'; base-uri 'none'; \
form-action https:";

/// A plain asset (an image, a text file) runs no script at all, even an SVG that carries one.
const ASSET_CSP: &str = "default-src 'none'; img-src data: blob:; media-src data: blob:; \
style-src 'unsafe-inline'; font-src data:";

/// Opaque origin for a page in its own window, or one oct:// site could read another's storage.
const WINDOW_SANDBOX: &str =
    "; sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox";

struct Doc {
    bytes: Vec<u8>,
    content_type: String,
    csp: String,
    page: bool,
}

struct Store {
    docs: HashMap<String, Doc>,
    order: VecDeque<String>,
}

fn store() -> &'static Mutex<Store> {
    static STORE: OnceLock<Mutex<Store>> = OnceLock::new();
    STORE.get_or_init(|| {
        Mutex::new(Store {
            docs: HashMap::new(),
            order: VecDeque::new(),
        })
    })
}

fn next_id() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng
        .try_fill_bytes(&mut bytes)
        .map_err(|e| format!("no random source: {e}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn is_id(id: &str) -> bool {
    id.len() == 64 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn put(doc: Doc) -> Result<String, String> {
    let id = next_id()?;
    let mut s = store().lock().unwrap_or_else(|e| e.into_inner());
    s.docs.insert(id.clone(), doc);
    s.order.push_back(id.clone());
    while s.order.len() > MAX_DOCS {
        if let Some(old) = s.order.pop_front() {
            s.docs.remove(&old);
        }
    }
    Ok(id)
}

pub fn forget_all() {
    let mut s = store().lock().unwrap_or_else(|e| e.into_inner());
    s.docs.clear();
    s.order.clear();
}

fn bind() -> std::io::Result<TcpListener> {
    TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))
}

pub(crate) fn port() -> Result<u16, String> {
    static PORT: OnceLock<Option<u16>> = OnceLock::new();
    PORT.get_or_init(|| {
        let listener = bind().ok()?;
        let port = listener.local_addr().ok()?.port();
        std::thread::Builder::new()
            .name("frame-listener".into())
            .spawn(move || accept(listener, port))
            .ok()?;
        Some(port)
    })
    .ok_or_else(|| "Framed content is unavailable".to_string())
}

pub(crate) fn origin() -> Result<String, String> {
    Ok(format!("http://127.0.0.1:{}", port()?))
}

fn frame_url(id: &str) -> Result<String, String> {
    Ok(format!("{}/{id}", origin()?))
}

fn accept(listener: TcpListener, port: u16) {
    static ACTIVE: AtomicUsize = AtomicUsize::new(0);
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        if ACTIVE.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
            ACTIVE.fetch_sub(1, Ordering::SeqCst);
            continue;
        }
        let spawned = std::thread::Builder::new()
            .name("frame-request".into())
            .spawn(move || {
                serve(stream, port);
                ACTIVE.fetch_sub(1, Ordering::SeqCst);
            });
        if spawned.is_err() {
            ACTIVE.fetch_sub(1, Ordering::SeqCst);
        }
    }
}

fn serve(mut stream: TcpStream, port: u16) {
    let _ = stream.set_write_timeout(Some(IO_TIMEOUT));
    let Some(head) = read_head(&mut stream) else {
        return;
    };
    let _ = stream.write_all(&answer(&head, port));
    let _ = stream.flush();
}

fn read_head(stream: &mut TcpStream) -> Option<Vec<u8>> {
    let deadline = Instant::now() + IO_TIMEOUT;
    let mut head = Vec::new();
    let mut buf = [0u8; 1024];
    while !head.windows(4).any(|w| w == b"\r\n\r\n") {
        let left = deadline.checked_duration_since(Instant::now())?;
        if head.len() > MAX_HEAD || left.is_zero() {
            return None;
        }
        stream.set_read_timeout(Some(left)).ok()?;
        match stream.read(&mut buf) {
            Ok(0) | Err(_) => return None,
            Ok(n) => head.extend_from_slice(&buf[..n]),
        }
    }
    Some(head)
}

fn refusal(status: &str) -> Vec<u8> {
    format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").into_bytes()
}

fn answer(head: &[u8], port: u16) -> Vec<u8> {
    let Ok(text) = std::str::from_utf8(head) else {
        return refusal("400 Bad Request");
    };
    let mut lines = text.split("\r\n");
    let mut request = lines.next().unwrap_or("").split(' ');
    let (Some(method), Some(target), Some("HTTP/1.1" | "HTTP/1.0"), None) = (
        request.next(),
        request.next(),
        request.next(),
        request.next(),
    ) else {
        return refusal("400 Bad Request");
    };
    if method != "GET" {
        return refusal("405 Method Not Allowed");
    }
    let mut hosts = lines
        .take_while(|line| !line.is_empty())
        .filter_map(|line| line.split_once(':'))
        .filter(|(name, _)| name.eq_ignore_ascii_case("host"))
        .map(|(_, value)| value.trim());
    // Security: a page on another name that resolves here (DNS rebinding) must get nothing.
    if hosts.next() != Some(format!("127.0.0.1:{port}").as_str()) || hosts.next().is_some() {
        return refusal("403 Forbidden");
    }
    let id = target
        .strip_prefix('/')
        .and_then(|rest| rest.split('?').next())
        .filter(|id| is_id(id));
    let found = id.and_then(|id| {
        let s = store().lock().unwrap_or_else(|e| e.into_inner());
        s.docs
            .get(id)
            .map(|d| (d.bytes.clone(), d.content_type.clone(), d.csp.clone()))
    });
    let Some((bytes, content_type, csp)) = found else {
        return refusal("404 Not Found");
    };
    let mut response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Security-Policy: {csp}\r\n\
X-Content-Type-Options: nosniff\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\n\
Content-Length: {}\r\nConnection: close\r\n\r\n",
        bytes.len()
    )
    .into_bytes();
    response.extend_from_slice(&bytes);
    response
}

/// Keeps an HTML document for a frame and returns its URL. `kind` is "page" for an oct:// site,
/// "chain" for a living NFT that reads `connect` (its network's RPC endpoint); anything else gets
/// the locked-down living NFT policy.
#[tauri::command]
pub fn stage_frame_document(
    html: String,
    kind: Option<String>,
    connect: Option<String>,
) -> Result<String, String> {
    let page = kind.as_deref() == Some("page");
    let csp = match kind.as_deref() {
        Some("page") => PAGE_CSP.to_string(),
        Some("chain") => chain_csp(connect.as_deref()),
        _ => NFT_CSP.to_string(),
    };
    frame_url(&put(Doc {
        bytes: html.into_bytes(),
        content_type: "text/html; charset=utf-8".to_string(),
        csp,
        page,
    })?)
}

#[tauri::command]
pub fn stage_frame_asset(base64: String, content_type: String) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64.trim())
        .map_err(|e| format!("invalid base64: {e}"))?;
    // HTML must come through stage_frame_document, which gives it a policy that suits it.
    let content_type = if content_type.to_ascii_lowercase().starts_with("text/html") {
        "text/plain; charset=utf-8".to_string()
    } else if content_type.is_empty() || !content_type.bytes().all(|b| (0x20..0x7f).contains(&b)) {
        "application/octet-stream".to_string()
    } else {
        content_type
    };
    frame_url(&put(Doc {
        bytes,
        content_type,
        csp: ASSET_CSP.to_string(),
        page: false,
    })?)
}

fn served_at(url: &url::Url, port: u16) -> bool {
    url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port() == Some(port)
        && url.username().is_empty()
        && url.password().is_none()
}

pub(crate) fn serves(url: &url::Url) -> bool {
    port().is_ok_and(|port| served_at(url, port))
}

pub(crate) fn staged_id(url: &url::Url) -> Option<&str> {
    let id = url.path().strip_prefix('/')?;
    (serves(url) && is_id(id)).then_some(id)
}

pub(crate) fn stage_window_copy(id: &str) -> Option<(url::Url, String)> {
    let copy = {
        let s = store().lock().unwrap_or_else(|e| e.into_inner());
        let doc = s.docs.get(id).filter(|d| d.page)?;
        Doc {
            bytes: doc.bytes.clone(),
            content_type: doc.content_type.clone(),
            csp: format!("{}{WINDOW_SANDBOX}", doc.csp),
            page: false,
        }
    };
    let id = put(copy).ok()?;
    Some((frame_url(&id).ok()?.parse().ok()?, id))
}

#[cfg(test)]
mod tests {
    use super::*;

    const OLD_NFT: &str = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'";
    const OLD_PAGE: &str = "default-src 'none'; script-src 'unsafe-inline' data: https:; style-src 'unsafe-inline' https:; img-src data: blob: https:; media-src data: blob: https:; font-src data: https:; connect-src https: wss:; frame-src 'none'; base-uri 'none'; form-action https:";
    const OLD_CHAIN: &str = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; base-uri 'none'; form-action 'none'; connect-src https://devnet.octrascan.io/rpc";
    const OLD_ASSET: &str = "default-src 'none'; img-src data: blob:; media-src data: blob:; style-src 'unsafe-inline'; font-src data:";
    const OLD_SANDBOX: &str =
        "; sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox";

    fn serial() -> std::sync::MutexGuard<'static, ()> {
        static GATE: Mutex<()> = Mutex::new(());
        GATE.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn send(raw: &str) -> String {
        let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port().unwrap())).unwrap();
        let _ = stream.write_all(raw.as_bytes());
        let mut out = Vec::new();
        let _ = stream.read_to_end(&mut out);
        String::from_utf8_lossy(&out).into_owned()
    }

    fn get(path: &str) -> String {
        let host = format!("127.0.0.1:{}", port().unwrap());
        send(&format!("GET {path} HTTP/1.1\r\nHost: {host}\r\n\r\n"))
    }

    fn path(url: &str) -> String {
        url.parse::<url::Url>().unwrap().path().to_string()
    }

    fn status(response: &str) -> &str {
        response.split("\r\n").next().unwrap()
    }

    fn page() -> String {
        stage_frame_document("<p>page</p>".into(), Some("page".into()), None).unwrap()
    }

    fn expected(content_type: &str, csp: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Security-Policy: {csp}\r\nX-Content-Type-Options: nosniff\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    #[test]
    fn chain_frames_reach_their_endpoint_only() {
        assert!(chain_csp(Some("https://devnet.octrascan.io/rpc"))
            .ends_with("connect-src https://devnet.octrascan.io/rpc"));
        assert!(chain_csp(Some("http://10.0.0.5:8080/rpc"))
            .ends_with("connect-src http://10.0.0.5:8080/rpc"));
        for bad in [
            "https://rpc-proxy.0xio.xyz/rpc/devnet",
            "https://octra.network/rpc; script-src *",
            "https://octra.network/rpc 'unsafe-eval'",
            "https://user@octra.network/rpc",
            "https://octra.network/rpc?x=1",
            "wss://octra.network/rpc",
            "https://:443/rpc",
            "https://octra.network:/rpc",
            "",
        ] {
            assert!(
                chain_csp(Some(bad)).ends_with("connect-src 'none'"),
                "{bad}"
            );
        }
        assert!(chain_csp(None).ends_with("connect-src 'none'"));
    }

    #[test]
    fn responses_carry_the_same_headers_and_policies_as_before() {
        let _gate = serial();
        let html = "text/html; charset=utf-8";
        assert_eq!(get(&path(&page())), expected(html, OLD_PAGE, "<p>page</p>"));
        let nft = stage_frame_document("<p>nft</p>".into(), Some("nft".into()), None).unwrap();
        assert_eq!(get(&path(&nft)), expected(html, OLD_NFT, "<p>nft</p>"));
        let other = stage_frame_document("<p>nft</p>".into(), None, None).unwrap();
        assert_eq!(get(&path(&other)), expected(html, OLD_NFT, "<p>nft</p>"));
        let chain = stage_frame_document(
            "<p>chain</p>".into(),
            Some("chain".into()),
            Some("https://devnet.octrascan.io/rpc".into()),
        )
        .unwrap();
        assert_eq!(
            get(&path(&chain)),
            expected(html, OLD_CHAIN, "<p>chain</p>")
        );
        let asset = stage_frame_asset("aGVsbG8=".into(), "image/png".into()).unwrap();
        assert_eq!(
            get(&path(&asset)),
            expected("image/png", OLD_ASSET, "hello")
        );
        let (copy, _) = stage_window_copy(&path(&page())[1..]).unwrap();
        assert_eq!(
            get(copy.path()),
            expected(html, &format!("{OLD_PAGE}{OLD_SANDBOX}"), "<p>page</p>")
        );
    }

    #[test]
    fn a_response_adds_no_cors_and_no_other_header() {
        let _gate = serial();
        let response = get(&path(&page())).to_ascii_lowercase();
        assert!(!response.contains("access-control"));
        let head = response.split("\r\n\r\n").next().unwrap();
        assert_eq!(head.lines().count(), 8);
    }

    #[test]
    fn the_query_is_ignored_and_the_path_must_be_the_whole_id() {
        let _gate = serial();
        let at = path(&page());
        assert_eq!(
            status(&get(&format!("{at}?seed=ab&st=1,2:3"))),
            "HTTP/1.1 200 OK"
        );
        for other in [
            format!("{at}/"),
            format!("{at}/more"),
            format!("/{at}"),
            format!("/x{at}"),
            at.to_ascii_uppercase(),
            at[..at.len() - 1].to_string(),
            format!("http://127.0.0.1:{}{at}", port().unwrap()),
            "https://octra.network/".to_string(),
            "/".to_string(),
            "/favicon.ico".to_string(),
            "/..".to_string(),
            "*".to_string(),
        ] {
            assert_eq!(status(&get(&other)), "HTTP/1.1 404 Not Found", "{other}");
        }
    }

    #[test]
    fn an_id_is_256_random_bits_and_never_repeats() {
        let _gate = serial();
        let a = path(&page());
        let b = path(&page());
        assert_ne!(a, b);
        for id in [&a[1..], &b[1..]] {
            assert!(is_id(id), "{id}");
        }
        let differing = a.bytes().zip(b.bytes()).filter(|(x, y)| x != y).count();
        assert!(differing > 32, "{a} {b}");
        let guess = format!("/{}", "0".repeat(64));
        assert_eq!(status(&get(&guess)), "HTTP/1.1 404 Not Found");
    }

    #[test]
    fn another_host_name_is_refused() {
        let _gate = serial();
        let at = path(&page());
        let port = port().unwrap();
        for host in [
            format!("Host: localhost:{port}\r\n"),
            format!("Host: rebind.example:{port}\r\n"),
            format!("Host: 127.0.0.1:{}\r\n", port.wrapping_add(1)),
            "Host: 127.0.0.1\r\n".to_string(),
            format!("Host: 127.0.0.1:{port}.rebind.example\r\n"),
            format!("Host: [::1]:{port}\r\n"),
            format!("Host: 127.0.0.1:{port}\r\nHost: rebind.example\r\n"),
            format!("Host: rebind.example\r\nHost: 127.0.0.1:{port}\r\n"),
            format!("X-Forwarded-Host: 127.0.0.1:{port}\r\n"),
            String::new(),
        ] {
            let response = send(&format!("GET {at} HTTP/1.1\r\n{host}\r\n"));
            assert_eq!(status(&response), "HTTP/1.1 403 Forbidden", "{host}");
            assert!(!response.contains("page"), "{host}");
        }
        let exact = send(&format!(
            "GET {at} HTTP/1.1\r\nhOsT:127.0.0.1:{port}\r\n\r\n"
        ));
        assert_eq!(status(&exact), "HTTP/1.1 200 OK");
    }

    #[test]
    fn only_get_is_answered() {
        let _gate = serial();
        let at = path(&page());
        let host = format!("127.0.0.1:{}", port().unwrap());
        for method in [
            "HEAD", "POST", "PUT", "DELETE", "OPTIONS", "CONNECT", "get", "PATCH",
        ] {
            let response = send(&format!(
                "{method} {at} HTTP/1.1\r\nHost: {host}\r\nContent-Length: 0\r\n\r\n"
            ));
            assert_eq!(
                status(&response),
                "HTTP/1.1 405 Method Not Allowed",
                "{method}"
            );
            assert!(!response.contains("page"), "{method}");
        }
        for broken in [
            format!("GET {at}\r\nHost: {host}\r\n\r\n"),
            format!("GET {at} HTTP/2\r\nHost: {host}\r\n\r\n"),
            format!("GET  {at} HTTP/1.1\r\nHost: {host}\r\n\r\n"),
            "\r\n\r\n".to_string(),
        ] {
            assert_eq!(
                status(&send(&broken)),
                "HTTP/1.1 400 Bad Request",
                "{broken}"
            );
        }
    }

    #[test]
    fn the_listener_binds_loopback_only() {
        let listener = bind().unwrap();
        let addr = listener.local_addr().unwrap();
        assert_eq!(addr.ip(), std::net::IpAddr::V4(Ipv4Addr::LOCALHOST));
        assert_ne!(addr.port(), 0);
        assert_ne!(bind().unwrap().local_addr().unwrap().port(), addr.port());
        let outward = std::net::UdpSocket::bind("0.0.0.0:0")
            .and_then(|s| s.connect("192.0.2.1:9").and_then(|_| s.local_addr()))
            .map(|a| a.ip())
            .ok()
            .filter(|ip| !ip.is_loopback() && !ip.is_unspecified());
        if let Some(ip) = outward {
            let reach = TcpStream::connect_timeout(
                &std::net::SocketAddr::new(ip, port().unwrap()),
                Duration::from_millis(500),
            );
            assert!(reach.is_err(), "reachable at {ip}");
        }
    }

    #[test]
    fn a_document_is_gone_once_dropped_or_locked() {
        let _gate = serial();
        let first = path(&page());
        assert_eq!(status(&get(&first)), "HTTP/1.1 200 OK");
        let mut last = String::new();
        for _ in 0..MAX_DOCS {
            last = path(&page());
        }
        assert_eq!(status(&get(&first)), "HTTP/1.1 404 Not Found");
        assert_eq!(status(&get(&last)), "HTTP/1.1 200 OK");
        let asset = path(&stage_frame_asset("AAAA".into(), "image/png".into()).unwrap());
        forget_all();
        for gone in [&last, &asset] {
            assert_eq!(status(&get(gone)), "HTTP/1.1 404 Not Found");
        }
        let s = store().lock().unwrap();
        assert!(s.docs.is_empty() && s.order.is_empty());
    }

    #[test]
    fn locking_the_wallet_drops_staged_documents() {
        let _gate = serial();
        let staged = path(&page());
        let asset = path(&stage_frame_asset("AAAA".into(), "image/png".into()).unwrap());
        assert_eq!(status(&get(&staged)), "HTTP/1.1 200 OK");
        crate::wallet::wallet_commands::lock_session();
        for gone in [&staged, &asset] {
            assert_eq!(status(&get(gone)), "HTTP/1.1 404 Not Found");
        }
    }

    #[test]
    fn an_asset_type_cannot_add_headers_or_pass_as_html() {
        let _gate = serial();
        let split = stage_frame_asset(
            "AAAA".into(),
            "image/png\r\nAccess-Control-Allow-Origin: *".into(),
        )
        .unwrap();
        let response = get(&path(&split));
        assert!(response.contains("Content-Type: application/octet-stream\r\n"));
        assert!(!response.contains("Access-Control"));
        let html = stage_frame_asset("AAAA".into(), "Text/HTML".into()).unwrap();
        assert!(get(&path(&html)).contains("Content-Type: text/plain; charset=utf-8\r\n"));
        let empty = stage_frame_asset("AAAA".into(), String::new()).unwrap();
        assert!(get(&path(&empty)).contains("Content-Type: application/octet-stream\r\n"));
    }

    #[test]
    fn an_oversized_request_gets_nothing() {
        let _gate = serial();
        let host = format!("127.0.0.1:{}", port().unwrap());
        let long = format!(
            "GET /{} HTTP/1.1\r\nHost: {host}\r\n\r\n",
            "a".repeat(MAX_HEAD * 2)
        );
        assert!(!send(&long).contains("200 OK"));
    }

    #[test]
    fn only_our_frame_urls_carry_a_staged_id() {
        let port = port().unwrap();
        let hex = "ab".repeat(32);
        let id = |u: &str| staged_id(&u.parse().unwrap()).map(str::to_string);
        assert_eq!(
            id(&format!("http://127.0.0.1:{port}/{hex}")),
            Some(hex.clone())
        );
        assert_eq!(
            id(&format!("http://127.0.0.1:{port}/{hex}?seed=1")),
            Some(hex.clone())
        );
        for other in [
            format!("https://pool.example/{hex}"),
            format!("http://localhost:{port}/{hex}"),
            format!("https://127.0.0.1:{port}/{hex}"),
            format!("http://127.0.0.1:{}/{hex}", port.wrapping_add(1)),
            format!("http://127.0.0.1/{hex}"),
            format!("http://user@127.0.0.1:{port}/{hex}"),
            format!("http://127.0.0.1.rebind.example:{port}/{hex}"),
            format!("http://127.0.0.1:{port}/"),
            format!("http://127.0.0.1:{port}/{hex}/more"),
            format!("http://127.0.0.1:{port}/{}", &hex[1..]),
            format!("http://127.0.0.1:{port}/{}", hex.to_ascii_uppercase()),
            format!("oxioframe://localhost/{hex}"),
            format!("http://oxioframe.localhost/{hex}"),
            format!("tauri://localhost/{hex}"),
        ] {
            assert_eq!(id(&other), None, "{other}");
        }
        let at = |u: &str| serves(&u.parse().unwrap());
        assert!(at(&format!("http://127.0.0.1:{port}/")));
        assert!(at(&format!("http://127.0.0.1:{port}/anything")));
        assert!(!at(&format!("http://localhost:{port}/")));
        assert!(!at(&format!("http://127.0.0.1:{}/", port.wrapping_add(1))));
    }

    #[test]
    fn a_window_copy_is_sandboxed_and_only_for_pages() {
        let _gate = serial();
        let page = path(&page())[1..].to_string();
        let (url, copy) = stage_window_copy(&page).unwrap();
        assert_ne!(copy, page);
        assert_eq!(staged_id(&url), Some(copy.as_str()));
        {
            let s = store().lock().unwrap();
            assert!(s.docs[&copy].csp.starts_with(PAGE_CSP));
            assert!(s.docs[&copy].csp.contains("; sandbox allow-scripts"));
            assert!(!s.docs[&copy].csp.contains("allow-same-origin"));
            assert!(!s.docs[&page].csp.contains("sandbox"));
        }
        assert!(stage_window_copy(&copy).is_none());
        let nft = stage_frame_document("<p>".into(), Some("nft".into()), None).unwrap();
        assert!(stage_window_copy(&path(&nft)[1..]).is_none());
        let asset = stage_frame_asset("AAAA".into(), "image/png".into()).unwrap();
        assert!(stage_window_copy(&path(&asset)[1..]).is_none());
        assert!(stage_window_copy("missing").is_none());
    }

    #[test]
    fn plain_nft_frames_stay_offline() {
        let _gate = serial();
        let url = stage_frame_document(
            "<p>".into(),
            Some("nft".into()),
            Some("https://octra.network/rpc".into()),
        )
        .unwrap();
        let s = store().lock().unwrap();
        assert!(s.docs[&path(&url)[1..]].csp.contains("connect-src 'none'"));
    }
}
