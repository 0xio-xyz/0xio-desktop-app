use std::collections::HashMap;
use std::sync::Mutex;

use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, Manager, Webview, WebviewUrl, WebviewWindowBuilder};

use crate::dapp::provider::provider_script;
use crate::guard::ipc_guard::require_main;
use crate::sites::frame_protocol::{serves, stage_window_copy, staged_id};
use crate::tlog;

struct Bound {
    doc: String,
    site: String,
}

static BOUND: Mutex<Option<HashMap<String, Bound>>> = Mutex::new(None);

fn bind(label: &str, bound: Option<Bound>) {
    let mut guard = BOUND.lock().unwrap_or_else(|e| e.into_inner());
    let map = guard.get_or_insert_with(HashMap::new);
    match bound {
        Some(b) => map.insert(label.to_string(), b),
        None => map.remove(label),
    };
}

fn circle_site(site: &str) -> Option<&str> {
    let id = site.strip_prefix("oct://")?;
    let ok = !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b));
    ok.then_some(site)
}

fn resolve_site(url: &url::Url, bound: Option<&Bound>) -> Option<String> {
    // Security: the origin that serves staged documents is never a site of its own.
    if serves(url) {
        let id = staged_id(url)?;
        return bound.filter(|b| b.doc == id).map(|b| b.site.clone());
    }
    matches!(url.scheme(), "http" | "https").then(|| url.origin().ascii_serialization())
}

pub(crate) fn site_of(label: &str, url: &url::Url) -> Option<String> {
    let guard = BOUND.lock().unwrap_or_else(|e| e.into_inner());
    resolve_site(url, guard.as_ref().and_then(|m| m.get(label)))
}

fn slug(text: &str) -> String {
    text.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

fn page_gone(app: &AppHandle, label: &str) {
    let _ = app.emit_to("main", "dapp-window-gone", serde_json::json!({ "label": label }));
}

#[tauri::command]
pub async fn dapp_open_window(
    webview: Webview,
    handle: AppHandle,
    url: String,
    title: Option<String>,
    site: Option<String>,
) -> Result<String, String> {
    require_main(&webview)?;
    let parsed: url::Url = url.parse().map_err(|e| format!("Invalid URL: {e}"))?;
    let staged = staged_id(&parsed).map(str::to_string);
    if !matches!(parsed.scheme(), "http" | "https") || (staged.is_none() && serves(&parsed)) {
        return Err("Only http(s) URLs can be opened".into());
    }
    // One window per dapp: several would each carry their own connection state and approval prompts
    // for what the user sees as one site.
    let (parsed, label, window_title, bound) = match staged {
        Some(id) => {
            let site = site
                .as_deref()
                .and_then(circle_site)
                .ok_or("This page cannot be opened in a window")?;
            let (copy, doc) =
                stage_window_copy(&id).ok_or("This page cannot be opened in a window")?;
            let label = format!("dapp-oct-{}", slug(&site[6..]));
            let bound = Bound {
                doc,
                site: site.to_string(),
            };
            (
                copy,
                label,
                title.unwrap_or_else(|| site.to_string()),
                Some(bound),
            )
        }
        None => {
            let host = parsed.host_str().unwrap_or("dapp");
            let label = match parsed.port() {
                Some(port) => format!("dapp-{}-{port}", slug(host)),
                None => format!("dapp-{}", slug(host)),
            };
            let title = title.unwrap_or_else(|| host.to_string());
            (parsed, label, title, None)
        }
    };
    let shown = bound.as_ref().map_or(url, |b| b.site.clone());
    bind(&label, bound);

    if let Some(existing) = handle.get_webview_window(&label) {
        let _ = existing.unminimize();
        let _ = existing.show();
        let _ = existing.set_focus();
        if let Err(e) = existing.navigate(parsed.clone()) {
            tlog!("[0xio-desktop] could not navigate {label}: {e}");
        }
        tlog!("[0xio-desktop] dApp window {label} reused -> {shown}");
        return Ok(label);
    }

    let window = WebviewWindowBuilder::new(&handle, &label, WebviewUrl::External(parsed))
        .title(window_title)
        .inner_size(1200.0, 820.0)
        .min_inner_size(420.0, 320.0)
        .center()
        .initialization_script(provider_script())
        .on_page_load(|w, payload| {
            if payload.event() == PageLoadEvent::Started {
                page_gone(w.app_handle(), w.label());
            }
        })
        .build()
        .map_err(|e| {
            bind(&label, None);
            format!("Failed to open dApp window: {e}")
        })?;
    let gone = (handle.clone(), label.clone());
    window.on_window_event(move |e| {
        if matches!(e, tauri::WindowEvent::Destroyed) {
            bind(&gone.1, None);
            page_gone(&gone.0, &gone.1);
        }
    });

    tlog!("[0xio-desktop] dApp window {label} -> {shown}");
    Ok(label)
}

/// Hidden rather than closed: the page and its session come back as they were on unlock.
#[tauri::command]
pub async fn dapp_set_windows_hidden(
    webview: Webview,
    app: AppHandle,
    hidden: bool,
) -> Result<(), String> {
    require_main(&webview)?;
    for (label, window) in app.webview_windows() {
        if !label.starts_with("dapp-") {
            continue;
        }
        let result = if hidden { window.hide() } else { window.show() };
        if let Err(e) = result {
            tlog!("[0xio-desktop] could not toggle dapp window {label}: {e}");
        }
    }
    Ok(())
}

pub(crate) fn delivers(allowed: &[String], origin: &str) -> bool {
    !origin.is_empty() && allowed.iter().any(|o| o == origin)
}

/// Every event names its sites; the site comes from the webview's own URL, never the page.
#[tauri::command]
pub async fn dapp_emit_event(
    webview: Webview,
    app: AppHandle,
    event: String,
    payload: serde_json::Value,
    origins: Vec<String>,
    label: Option<String>,
) -> Result<(), String> {
    require_main(&webview)?;
    if origins.is_empty() {
        return Ok(());
    }
    let event_js = serde_json::to_string(&event).map_err(|e| e.to_string())?;
    let payload_js = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
    let js = format!("window.__octraEmit && window.__octraEmit({event_js}, {payload_js});");
    for (name, window) in app.webview_windows() {
        if !name.starts_with("dapp-") || label.as_deref().is_some_and(|l| l != name) {
            continue;
        }
        let origin = window
            .url()
            .ok()
            .and_then(|u| site_of(&name, &u))
            .unwrap_or_default();
        if !delivers(&origins, &origin) {
            continue;
        }
        if let Err(e) = window.eval(&js) {
            tlog!("[0xio-desktop] could not emit {event} to {name}: {e}");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{circle_site, delivers, resolve_site, Bound};

    fn site(url: &str, bound: Option<&Bound>) -> Option<String> {
        resolve_site(&url.parse().unwrap(), bound)
    }

    #[test]
    fn a_web_page_speaks_for_its_own_origin() {
        assert_eq!(
            site("https://pool.example/swap?x=1", None).as_deref(),
            Some("https://pool.example")
        );
        assert_eq!(
            site("http://localhost:5173/", None).as_deref(),
            Some("http://localhost:5173")
        );
        for other in [
            "tauri://localhost/",
            "about:blank",
            "data:text/html,x",
            "file:///etc/hosts",
        ] {
            assert_eq!(site(other, None), None, "{other}");
        }
    }

    #[test]
    fn a_staged_page_speaks_only_for_the_circle_its_window_was_bound_to() {
        let origin = crate::sites::frame_protocol::origin().unwrap();
        let doc = "ab".repeat(32);
        let other = "cd".repeat(32);
        let bound = Bound {
            doc: doc.clone(),
            site: "oct://circleA".into(),
        };
        let url = format!("{origin}/{doc}");
        assert_eq!(site(&url, Some(&bound)).as_deref(), Some("oct://circleA"));
        assert_eq!(
            site(&format!("{url}?x=1"), Some(&bound)).as_deref(),
            Some("oct://circleA")
        );
        assert_eq!(site(&url, None), None);
        for unbound in [
            format!("{origin}/{other}"),
            format!("{origin}/"),
            format!("{origin}/{doc}/more"),
            format!("{origin}/index.html"),
        ] {
            assert_eq!(site(&unbound, Some(&bound)), None, "{unbound}");
            assert_eq!(site(&unbound, None), None, "{unbound}");
        }
        assert_eq!(
            site("https://pool.example/", Some(&bound)).as_deref(),
            Some("https://pool.example")
        );
        assert_eq!(site(&format!("oxioframe://localhost/{doc}"), Some(&bound)), None);
    }

    #[test]
    fn only_a_circle_can_be_bound() {
        assert_eq!(circle_site("oct://circleA"), Some("oct://circleA"));
        for bad in [
            "oct://",
            "https://pool.example",
            "oct://a/b",
            "oct://a b",
            "oct://a?x",
            "circleA",
        ] {
            assert_eq!(circle_site(bad), None, "{bad}");
        }
    }

    #[test]
    fn an_event_reaches_only_the_sites_it_names() {
        let allowed = vec!["https://a.example".to_string()];
        assert!(delivers(&allowed, "https://a.example"));
        assert!(!delivers(&allowed, "https://b.example"));
        assert!(!delivers(&allowed, "http://a.example"));
        assert!(!delivers(&allowed, "https://a.example:8443"));
    }

    #[test]
    fn an_empty_list_reaches_nobody() {
        assert!(!delivers(&[], "https://a.example"));
        assert!(!delivers(&["".to_string()], ""));
    }
}
