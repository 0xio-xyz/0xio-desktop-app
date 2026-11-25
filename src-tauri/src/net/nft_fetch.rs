use std::future::Future;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use tauri_plugin_http::reqwest;
use url::{Host, Url};

use crate::guard::ipc_guard::require_main;

const MAX_REDIRECTS: usize = 3;
const TIMEOUT: Duration = Duration::from_secs(15);
const USER_AGENT: &str = "0xio-desktop";
const LOCAL_SUFFIXES: &[&str] = &[".localhost", ".local", ".internal", ".lan", ".home.arpa"];

#[derive(Clone, Copy, Debug, PartialEq)]
enum Kind {
    Metadata,
    Image,
}

impl Kind {
    fn parse(raw: &str) -> Result<Self, String> {
        match raw {
            "metadata" => Ok(Self::Metadata),
            "image" => Ok(Self::Image),
            _ => Err("Unknown kind".into()),
        }
    }

    fn cap(self) -> usize {
        match self {
            Self::Metadata => 256 * 1024,
            Self::Image => 2 * 1024 * 1024,
        }
    }

    fn types(self) -> &'static [&'static str] {
        match self {
            Self::Metadata => &["application/json", "text/plain"],
            Self::Image => &["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"],
        }
    }
}

enum Hop {
    Redirect(String),
    Body { content_type: String, bytes: Vec<u8> },
}

fn refused_v4(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_multicast()
        || ip.is_broadcast()
        || ip.is_documentation()
        || o[0] == 0
        || (o[0] == 100 && o[1] & 0xC0 == 64)
        || (o[0] == 192 && o[1] == 0 && o[2] == 0)
        || (o[0] == 198 && o[1] & 0xFE == 18)
        || o[0] >= 240
}

fn refused_v6(ip: Ipv6Addr) -> bool {
    let s = ip.segments();
    let tail = Ipv4Addr::new((s[6] >> 8) as u8, s[6] as u8, (s[7] >> 8) as u8, s[7] as u8);
    if s[..5] == [0; 5] && (s[5] == 0 || s[5] == 0xFFFF) {
        return s[5] == 0 || refused_v4(tail);
    }
    if s[..6] == [0x64, 0xFF9B, 0, 0, 0, 0] {
        return refused_v4(tail);
    }
    if s[0] == 0x2002 {
        return refused_v4(Ipv4Addr::new((s[1] >> 8) as u8, s[1] as u8, (s[2] >> 8) as u8, s[2] as u8));
    }
    ip.is_multicast()
        || s[0] & 0xFE00 == 0xFC00
        || s[0] & 0xFFC0 == 0xFE80
        || s[0] & 0xFFC0 == 0xFEC0
        || (s[0] == 0x2001 && s[1] == 0x0DB8)
}

fn check_ip(ip: IpAddr) -> Result<(), String> {
    let refused = match ip {
        IpAddr::V4(v4) => refused_v4(v4),
        IpAddr::V6(v6) => refused_v6(v6),
    };
    if refused {
        return Err("Address not allowed".into());
    }
    Ok(())
}

fn check_url(raw: &str) -> Result<Url, String> {
    let mut url = Url::parse(raw).map_err(|_| "Not a valid address")?;
    if url.scheme() != "https" {
        return Err("Only https is allowed".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Credentials are not allowed".into());
    }
    if url.port().is_some() {
        return Err("Port not allowed".into());
    }
    match url.host() {
        Some(Host::Domain(name)) => {
            let name = name.trim_end_matches('.').to_ascii_lowercase();
            if name == "localhost" || !name.contains('.') || LOCAL_SUFFIXES.iter().any(|s| name.ends_with(s)) {
                return Err("Address not allowed".into());
            }
        }
        Some(Host::Ipv4(ip)) => check_ip(IpAddr::V4(ip))?,
        Some(Host::Ipv6(ip)) => check_ip(IpAddr::V6(ip))?,
        None => return Err("Not a valid address".into()),
    }
    url.set_fragment(None);
    Ok(url)
}

fn checked(found: Vec<SocketAddr>) -> Result<Vec<SocketAddr>, String> {
    if found.is_empty() {
        return Err("Host not found".into());
    }
    for addr in &found {
        check_ip(addr.ip())?;
    }
    Ok(found)
}

fn media_type(header: &str) -> String {
    header.split(';').next().unwrap_or("").trim().to_ascii_lowercase()
}

fn check_type(kind: Kind, header: &str) -> Result<String, String> {
    let found = media_type(header);
    if kind.types().contains(&found.as_str()) {
        Ok(found)
    } else {
        Err("Content type not allowed".into())
    }
}

fn take(into: &mut Vec<u8>, chunk: &[u8], cap: usize) -> Result<(), String> {
    if into.len() + chunk.len() > cap {
        return Err("Too large".into());
    }
    into.extend_from_slice(chunk);
    Ok(())
}

fn finish(kind: Kind, content_type: &str, bytes: Vec<u8>) -> Result<String, String> {
    let found = check_type(kind, content_type)?;
    if bytes.len() > kind.cap() {
        return Err("Too large".into());
    }
    match kind {
        Kind::Metadata => {
            let text = String::from_utf8(bytes).map_err(|_| "Not JSON")?;
            serde_json::from_str::<serde_json::Value>(&text).map_err(|_| "Not JSON")?;
            Ok(text)
        }
        Kind::Image => Ok(format!("data:{found};base64,{}", STANDARD.encode(bytes))),
    }
}

async fn follow<F, Fut>(raw: &str, kind: Kind, hop: F) -> Result<String, String>
where
    F: Fn(Url, Kind) -> Fut,
    Fut: Future<Output = Result<Hop, String>>,
{
    let mut url = check_url(raw)?;
    for _ in 0..=MAX_REDIRECTS {
        match hop(url.clone(), kind).await? {
            Hop::Redirect(location) => {
                let next = url.join(&location).map_err(|_| "Not a valid address")?;
                url = check_url(next.as_str())?;
            }
            Hop::Body { content_type, bytes } => return finish(kind, &content_type, bytes),
        }
    }
    Err("Too many redirects".into())
}

async fn guarded<F, Fut>(raw: &str, kind: Kind, limit: Duration, hop: F) -> Result<String, String>
where
    F: Fn(Url, Kind) -> Fut,
    Fut: Future<Output = Result<Hop, String>>,
{
    tokio::time::timeout(limit, follow(raw, kind, hop)).await.map_err(|_| "Timed out".to_string())?
}

async fn request(url: Url, kind: Kind) -> Result<Hop, String> {
    let mut client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .https_only(true)
        .user_agent(USER_AGENT);
    // The request connects to the addresses checked here, never to a second DNS answer.
    if let Some(Host::Domain(name)) = url.host() {
        let found = tokio::net::lookup_host((name, 443)).await.map_err(|_| "Host not found")?;
        client = client.resolve_to_addrs(name, &checked(found.collect())?);
    }
    let client = client.build().map_err(|e| e.to_string())?;
    let mut reply = client
        .get(url)
        .header(reqwest::header::ACCEPT, kind.types().join(", "))
        .send()
        .await
        .map_err(|e| e.without_url().to_string())?;
    let status = reply.status();
    let header = |name| reply.headers().get(name).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    if status.is_redirection() {
        return Ok(Hop::Redirect(header(reqwest::header::LOCATION)));
    }
    if !status.is_success() {
        return Err(format!("HTTP {}", status.as_u16()));
    }
    let content_type = header(reqwest::header::CONTENT_TYPE);
    check_type(kind, &content_type)?;
    if reply.content_length().is_some_and(|n| n > kind.cap() as u64) {
        return Err("Too large".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = reply.chunk().await.map_err(|e| e.without_url().to_string())? {
        take(&mut bytes, &chunk, kind.cap())?;
    }
    Ok(Hop::Body { content_type, bytes })
}

#[tauri::command]
pub async fn nft_fetch<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
    url: String,
    kind: String,
) -> Result<String, String> {
    require_main(&webview)?;
    guarded(&url, Kind::parse(&kind)?, TIMEOUT, request).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn run<F, Fut>(raw: &str, kind: Kind, hop: F) -> Result<String, String>
    where
        F: Fn(Url, Kind) -> Fut,
        Fut: Future<Output = Result<Hop, String>>,
    {
        tauri::async_runtime::block_on(guarded(raw, kind, Duration::from_secs(5), hop))
    }

    fn body(content_type: &str, bytes: &[u8]) -> Result<Hop, String> {
        Ok(Hop::Body { content_type: content_type.into(), bytes: bytes.to_vec() })
    }

    #[test]
    #[ignore]
    fn live_hosts_answer_through_the_real_request() {
        let live = |name: &str, kind: Kind| {
            std::env::var(name)
                .ok()
                .map(|url| tauri::async_runtime::block_on(guarded(&url, kind, TIMEOUT, request)))
        };
        if let Some(found) = live("NFT_FETCH_METADATA", Kind::Metadata) {
            assert!(found.unwrap().starts_with('{'));
        }
        if let Some(found) = live("NFT_FETCH_IMAGE", Kind::Image) {
            assert!(found.unwrap().starts_with("data:image/"));
        }
        if let Some(found) = live("NFT_FETCH_REFUSED", Kind::Metadata) {
            assert!(found.is_err());
        }
    }

    #[test]
    fn only_plain_https_addresses_pass() {
        assert!(check_url("https://names.example/meta/0.json").is_ok());
        assert_eq!(check_url("https://names.example/a#part").unwrap().as_str(), "https://names.example/a");
        for refused in [
            "http://names.example/a",
            "ftp://names.example/a",
            "file:///etc/hosts",
            "data:application/json,{}",
            "oct://circle/a.json",
            "names.example/a",
            "",
        ] {
            assert!(check_url(refused).is_err(), "{refused}");
        }
        assert_eq!(check_url("https://user:pass@names.example/a").unwrap_err(), "Credentials are not allowed");
        assert_eq!(check_url("https://user@names.example/a").unwrap_err(), "Credentials are not allowed");
        assert_eq!(check_url("https://names.example:8443/a").unwrap_err(), "Port not allowed");
        assert!(check_url("https://names.example:443/a").is_ok());
    }

    #[test]
    fn local_names_are_refused() {
        for refused in [
            "https://localhost/a",
            "https://LOCALHOST./a",
            "https://api.localhost/a",
            "https://printer.local/a",
            "https://db.internal/a",
            "https://router.lan/a",
            "https://nas.home.arpa/a",
            "https://intranet/a",
        ] {
            assert_eq!(check_url(refused).unwrap_err(), "Address not allowed", "{refused}");
        }
    }

    #[test]
    fn every_local_address_range_is_refused() {
        for refused in [
            "127.0.0.1",
            "127.255.255.254",
            "10.0.0.1",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "100.127.255.255",
            "224.0.0.1",
            "239.255.255.250",
            "0.0.0.0",
            "0.1.2.3",
            "255.255.255.255",
            "192.0.0.1",
            "198.18.0.1",
            "240.0.0.1",
            "::",
            "::1",
            "fe80::1",
            "febf::1",
            "fc00::1",
            "fd12:3456::1",
            "fec0::1",
            "ff02::1",
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.1",
            "::ffff:192.168.1.1",
            "::ffff:169.254.169.254",
            "::ffff:100.64.0.1",
            "::ffff:0.0.0.0",
            "::10.0.0.1",
            "64:ff9b::10.0.0.1",
            "2002:c0a8:0101::1",
        ] {
            let ip: IpAddr = refused.parse().unwrap();
            assert!(check_ip(ip).is_err(), "{refused}");
            let host = if ip.is_ipv6() { format!("[{refused}]") } else { refused.to_string() };
            assert!(check_url(&format!("https://{host}/a")).is_err(), "{refused}");
            assert!(checked(vec![SocketAddr::new(ip, 443)]).is_err(), "{refused}");
        }
        for allowed in ["1.1.1.1", "100.63.255.255", "100.128.0.1", "172.32.0.1", "2606:4700::1111", "::ffff:1.1.1.1"] {
            assert!(check_ip(allowed.parse().unwrap()).is_ok(), "{allowed}");
        }
    }

    #[test]
    fn number_forms_of_a_local_address_are_refused() {
        for refused in [
            "https://2130706433/a",
            "https://0x7f000001/a",
            "https://0x7f.1/a",
            "https://0177.0.0.1/a",
            "https://127.1/a",
            "https://3232235777/a",
            "https://0xa9fea9fe/a",
        ] {
            assert_eq!(check_url(refused).unwrap_err(), "Address not allowed", "{refused}");
        }
    }

    #[test]
    fn one_refused_answer_refuses_the_host() {
        let public = SocketAddr::new("1.1.1.1".parse().unwrap(), 443);
        let private = SocketAddr::new("10.0.0.5".parse().unwrap(), 443);
        assert_eq!(checked(vec![public]).unwrap(), [public]);
        assert!(checked(vec![public, private]).is_err());
        assert_eq!(checked(Vec::new()).unwrap_err(), "Host not found");
    }

    #[test]
    fn three_redirects_pass_and_a_fourth_fails() {
        let hops = AtomicUsize::new(0);
        let chain = |allowed: usize| {
            hops.store(0, Ordering::SeqCst);
            run("https://names.example/0", Kind::Metadata, |url, _| {
                let n = hops.fetch_add(1, Ordering::SeqCst);
                async move {
                    assert_eq!(url.path(), format!("/{n}"));
                    if n < allowed {
                        Ok(Hop::Redirect(format!("/{}", n + 1)))
                    } else {
                        body("application/json", b"{}")
                    }
                }
            })
        };
        assert_eq!(chain(3).unwrap(), "{}");
        assert_eq!(hops.load(Ordering::SeqCst), 4);
        assert_eq!(chain(4).unwrap_err(), "Too many redirects");
        assert_eq!(hops.load(Ordering::SeqCst), 4);
    }

    #[test]
    fn a_redirect_to_a_refused_address_stops_before_the_request() {
        for (location, why) in [
            ("http://names.example/a", "Only https is allowed"),
            ("https://127.0.0.1/a", "Address not allowed"),
            ("https://[::ffff:10.0.0.1]/a", "Address not allowed"),
            ("https://169.254.169.254/latest/meta-data", "Address not allowed"),
            ("//localhost/a", "Address not allowed"),
            ("https://user:pass@other.example/a", "Credentials are not allowed"),
            ("https://other.example:8443/a", "Port not allowed"),
            ("file:///etc/hosts", "Only https is allowed"),
        ] {
            let hops = AtomicUsize::new(0);
            let result = run("https://names.example/a", Kind::Image, |_, _| {
                hops.fetch_add(1, Ordering::SeqCst);
                async move { Ok(Hop::Redirect(location.to_string())) }
            });
            assert_eq!(result.unwrap_err(), why, "{location}");
            assert_eq!(hops.load(Ordering::SeqCst), 1, "{location}");
        }
    }

    #[test]
    fn a_redirect_to_another_https_host_is_followed() {
        let result = run("https://names.example/a", Kind::Metadata, |url, _| async move {
            if url.host_str() == Some("names.example") {
                Ok(Hop::Redirect("https://cdn.example/b.json".into()))
            } else {
                assert_eq!(url.as_str(), "https://cdn.example/b.json");
                body("text/plain; charset=utf-8", b"{\"name\":\"0xio.oct\"}")
            }
        });
        assert_eq!(result.unwrap(), "{\"name\":\"0xio.oct\"}");
    }

    #[test]
    fn a_refused_first_address_makes_no_request() {
        let hops = AtomicUsize::new(0);
        let result = run("https://192.168.1.1/a", Kind::Image, |_, _| {
            hops.fetch_add(1, Ordering::SeqCst);
            async { body("image/png", b"x") }
        });
        assert_eq!(result.unwrap_err(), "Address not allowed");
        assert_eq!(hops.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn reading_stops_at_the_size_cap() {
        for kind in [Kind::Metadata, Kind::Image] {
            let mut bytes = Vec::new();
            let chunk = vec![b'a'; 64 * 1024];
            let mut taken = 0;
            while take(&mut bytes, &chunk, kind.cap()).is_ok() {
                taken += 1;
            }
            assert_eq!(taken * chunk.len(), kind.cap());
            assert_eq!(bytes.len(), kind.cap());
            assert_eq!(take(&mut bytes, b"a", kind.cap()).unwrap_err(), "Too large");
        }
        assert_eq!((Kind::Metadata.cap(), Kind::Image.cap()), (262_144, 2_097_152));
        let over = vec![b' '; Kind::Metadata.cap() + 1];
        assert_eq!(finish(Kind::Metadata, "application/json", over).unwrap_err(), "Too large");
    }

    #[test]
    fn content_types_are_allowed_by_kind() {
        for allowed in ["application/json", "Application/JSON; charset=utf-8", "text/plain"] {
            assert!(check_type(Kind::Metadata, allowed).is_ok(), "{allowed}");
        }
        for allowed in ["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml; charset=utf-8"] {
            assert!(check_type(Kind::Image, allowed).is_ok(), "{allowed}");
        }
        for refused in ["", "text/html", "image/png", "application/octet-stream", "application/json5"] {
            assert!(check_type(Kind::Metadata, refused).is_err(), "{refused}");
        }
        for refused in ["", "text/html", "application/json", "image/bmp", "image/svg", "text/plain", "video/mp4"] {
            assert!(check_type(Kind::Image, refused).is_err(), "{refused}");
        }
        let html = run("https://names.example/a", Kind::Image, |_, _| async { body("text/html", b"<p>") });
        assert_eq!(html.unwrap_err(), "Content type not allowed");
        assert!(Kind::parse("page").is_err());
    }

    #[test]
    fn metadata_is_strict_json_and_an_image_is_a_data_url() {
        let get = |kind, content_type: &'static str, bytes: &'static [u8]| {
            run("https://names.example/a", kind, move |_, _| async move { body(content_type, bytes) })
        };
        assert_eq!(get(Kind::Metadata, "text/plain", b"{\"image\":\"a\"}").unwrap(), "{\"image\":\"a\"}");
        assert_eq!(get(Kind::Metadata, "application/json", b"{name: 1}").unwrap_err(), "Not JSON");
        assert_eq!(get(Kind::Metadata, "application/json", b"<html>").unwrap_err(), "Not JSON");
        assert_eq!(get(Kind::Metadata, "application/json", &[0xFF, 0xFE]).unwrap_err(), "Not JSON");
        assert_eq!(
            get(Kind::Image, "image/svg+xml; charset=utf-8", b"<svg/>").unwrap(),
            "data:image/svg+xml;base64,PHN2Zy8+"
        );
    }

    #[test]
    fn a_slow_host_times_out() {
        let slow = guarded("https://names.example/a", Kind::Image, Duration::from_millis(30), |_, _| async {
            tokio::time::sleep(Duration::from_secs(30)).await;
            body("image/png", b"x")
        });
        assert_eq!(tauri::async_runtime::block_on(slow).unwrap_err(), "Timed out");
        assert_eq!(TIMEOUT, Duration::from_secs(15));
    }

    #[test]
    fn the_command_is_for_the_main_window_only() {
        let granted = |text: &str| text.contains("\"allow-nft-fetch\"");
        assert!(granted(include_str!("../../permissions/main-window.toml")));
        assert!(!granted(include_str!("../../permissions/tray-window.toml")));
        assert!(!include_str!("../../capabilities/dapp.json").contains("nft-fetch"));
        assert!(!include_str!("../../capabilities/tray.json").contains("nft-fetch"));
    }
}
