use std::error::Error as _;
use std::sync::OnceLock;
use std::time::Duration;

use serde::Serialize;
use tauri_plugin_http::reqwest;

use crate::guard::ipc_guard::require_main;

const CONNECT_LIMIT: Duration = Duration::from_secs(5);
const MAX_TIMEOUT_MS: u64 = 900_000;
const CLIENT_HEADER: &str = "x-0xio-client";

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Link {
    Unopened,
    Untrusted,
    Broken,
    Expired,
    Answered,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Exchange {
    link: Link,
    status: u16,
    body: String,
    retry_after: Option<String>,
}

impl Exchange {
    fn failed(link: Link) -> Self {
        Self { link, status: 0, body: String::new(), retry_after: None }
    }
}

fn certificate_refused(err: &reqwest::Error) -> bool {
    let mut source = err.source();
    while let Some(cause) = source {
        if cause.to_string().to_ascii_lowercase().contains("certificate") {
            return true;
        }
        source = cause.source();
    }
    false
}

fn link_of(err: &reqwest::Error) -> Link {
    if err.is_connect() {
        if certificate_refused(err) {
            Link::Untrusted
        } else {
            Link::Unopened
        }
    } else if err.is_timeout() {
        Link::Expired
    } else {
        Link::Broken
    }
}

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(CONNECT_LIMIT)
            .user_agent("0xio-desktop")
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

fn check_url(raw: &str) -> Result<url::Url, String> {
    let url = url::Url::parse(raw).map_err(|_| "Invalid RPC URL".to_string())?;
    match url.scheme() {
        "http" | "https" => Ok(url),
        _ => Err("Invalid RPC URL".into()),
    }
}

async fn post(client: &reqwest::Client, url: url::Url, body: String, timeout: Duration, tag: Option<String>) -> Exchange {
    let mut request = client
        .post(url)
        .timeout(timeout)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body);
    if let Some(tag) = tag {
        request = request.header(CLIENT_HEADER, tag);
    }
    let reply = match request.send().await {
        Ok(reply) => reply,
        Err(err) => return Exchange::failed(link_of(&err)),
    };
    let status = reply.status().as_u16();
    let retry_after = reply
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    match reply.text().await {
        Ok(body) => Exchange { link: Link::Answered, status, body, retry_after },
        Err(err) => Exchange::failed(if err.is_timeout() { Link::Expired } else { Link::Broken }),
    }
}

#[tauri::command]
pub async fn node_rpc_post<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
    url: String,
    body: String,
    timeout_ms: u64,
    client_tag: Option<String>,
) -> Result<Exchange, String> {
    require_main(&webview)?;
    let url = check_url(&url)?;
    if timeout_ms == 0 || timeout_ms > MAX_TIMEOUT_MS {
        return Err("Invalid RPC timeout".into());
    }
    let tag = client_tag.filter(|t| t == "desktop");
    let method = rpc_method(&body).to_owned();
    let sent = body.len();
    let t0 = std::time::Instant::now();
    let exchange = post(client(), url, body, Duration::from_millis(timeout_ms), tag).await;
    if method.starts_with("octra_submit") || sent >= 64 * 1024 {
        eprintln!(
            "{} [rpc] {} sent {} KB, status {} in {} ms",
            crate::ts(),
            method,
            sent / 1024,
            exchange.status,
            t0.elapsed().as_millis()
        );
    }
    Ok(exchange)
}

fn rpc_method(body: &str) -> &str {
    body.split_once("\"method\"").and_then(|(_, rest)| rest.split('"').nth(1)).unwrap_or("?")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    fn run(url: &str, timeout: Duration) -> Exchange {
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        tauri::async_runtime::block_on(post(&client, check_url(url).unwrap(), "{}".into(), timeout, None))
    }

    fn serve(reply: impl FnOnce(std::net::TcpStream) + Send + 'static) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        thread::spawn(move || {
            if let Ok((stream, _)) = listener.accept() {
                reply(stream);
            }
        });
        format!("http://{addr}/rpc")
    }

    fn read_request(stream: &mut std::net::TcpStream) {
        let mut buf = [0u8; 4096];
        let _ = stream.read(&mut buf);
    }

    #[test]
    fn reads_the_method_for_the_log() {
        assert_eq!(rpc_method(r#"{"jsonrpc":"2.0","method":"octra_submit","params":[]}"#), "octra_submit");
        assert_eq!(rpc_method(r#"{"method": "octra_balance"}"#), "octra_balance");
        assert_eq!(rpc_method("{}"), "?");
    }

    #[test]
    fn a_refused_connection_is_unopened() {
        let addr = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap();
        let out = run(&format!("http://{addr}/rpc"), Duration::from_secs(2));
        assert_eq!(out.link, Link::Unopened);
    }

    #[test]
    fn a_failed_tls_handshake_is_unopened() {
        let url = serve(|mut s| {
            read_request(&mut s);
            let _ = s.write_all(b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        });
        let out = run(&url.replace("http://", "https://"), Duration::from_secs(2));
        assert_eq!(out.link, Link::Unopened);
    }

    #[test]
    fn a_silent_node_is_expired() {
        let url = serve(|mut s| {
            read_request(&mut s);
            thread::sleep(Duration::from_secs(2));
        });
        assert_eq!(run(&url, Duration::from_millis(300)).link, Link::Expired);
    }

    #[test]
    fn a_reset_after_send_is_broken() {
        let url = serve(|mut s| read_request(&mut s));
        assert_eq!(run(&url, Duration::from_secs(2)).link, Link::Broken);
    }

    #[test]
    fn an_answer_carries_status_body_and_retry_after() {
        let url = serve(|mut s| {
            read_request(&mut s);
            let body = r#"{"jsonrpc":"2.0","id":null,"error":{"code":-32005,"message":"capacity"}}"#;
            let head = format!(
                "HTTP/1.1 429 Too Many Requests\r\nRetry-After: 3\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = s.write_all(head.as_bytes());
            let _ = s.write_all(body.as_bytes());
        });
        let out = run(&url, Duration::from_secs(2));
        assert_eq!(out.link, Link::Answered);
        assert_eq!(out.status, 429);
        assert_eq!(out.retry_after.as_deref(), Some("3"));
        assert!(out.body.contains("capacity"));
    }

    #[test]
    fn only_http_addresses_pass() {
        assert!(check_url("https://octra.network/rpc").is_ok());
        assert!(check_url("http://127.0.0.1:8080/rpc").is_ok());
        for refused in ["file:///etc/hosts", "oct://circle/a", "data:text/plain,x", "octra.network/rpc", ""] {
            assert!(check_url(refused).is_err(), "{refused}");
        }
    }
}
