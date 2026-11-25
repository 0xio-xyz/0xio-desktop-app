//! Menu bar tray: the icon, a short native menu, and the panel window.
//!
//! The main window stays the only owner of wallet state. It publishes a snapshot here
//! (`tray_publish`), the panel reads it (`tray_get_state`, `tray-state` event) and asks for
//! changes (`tray_action`), which are forwarded to the main window to run its own code paths.
//! A password typed in the panel is checked here and never travels to another window.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{
    image::Image,
    menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Listener, LogicalPosition, Manager, Monitor, PhysicalPosition, Rect, Runtime,
    Webview, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

use crate::guard::ipc_guard::{require_main, require_tray, TRAY_WINDOW};
use crate::state::AppState;
use crate::system::autostart;
use crate::tlog;

const TRAY_ID: &str = "main-tray";
const PANEL_W: f64 = 320.0;
const PANEL_H: f64 = 404.0;
const PANEL_RADIUS: f64 = 24.0;
const GAP: f64 = 6.0;
const AUTH_HOLD_MAX: Duration = Duration::from_secs(90);
const AUTH_GRACE: Duration = Duration::from_millis(1500);
const REKEY_AFTER: [Duration; 2] = [Duration::from_millis(400), Duration::from_millis(900)];

const ICON_PLAIN: &[u8] = include_bytes!("../../icons/tray-icon.png");
const ICON_LOCKED: &[u8] = include_bytes!("../../icons/tray/tray-locked.png");
const ICON_WORKING: [&[u8]; 12] = [
    include_bytes!("../../icons/tray/tray-working-00.png"),
    include_bytes!("../../icons/tray/tray-working-01.png"),
    include_bytes!("../../icons/tray/tray-working-02.png"),
    include_bytes!("../../icons/tray/tray-working-03.png"),
    include_bytes!("../../icons/tray/tray-working-04.png"),
    include_bytes!("../../icons/tray/tray-working-05.png"),
    include_bytes!("../../icons/tray/tray-working-06.png"),
    include_bytes!("../../icons/tray/tray-working-07.png"),
    include_bytes!("../../icons/tray/tray-working-08.png"),
    include_bytes!("../../icons/tray/tray-working-09.png"),
    include_bytes!("../../icons/tray/tray-working-10.png"),
    include_bytes!("../../icons/tray/tray-working-11.png"),
];

#[derive(Default)]
struct Shared {
    snapshot: Option<Value>,
    icon_rect: Option<Rect>,
    hidden_at: Option<Instant>,
    /// A Touch ID prompt is up: its system window takes focus, which must not hide the panel.
    auth_hold_until: Option<Instant>,
    blurred_in_hold: bool,
    shown_icon: Option<usize>,
    shown_title: Option<String>,
    site_waiting: usize,
}

const KEY_PLAIN: usize = usize::MAX;
const KEY_LOCKED: usize = usize::MAX - 1;

static SHARED: Mutex<Option<Shared>> = Mutex::new(None);
static ANIMATING: AtomicBool = AtomicBool::new(false);
static FRAME: AtomicUsize = AtomicUsize::new(0);
static QUITTING: AtomicBool = AtomicBool::new(false);

fn with_shared<T>(f: impl FnOnce(&mut Shared) -> T) -> T {
    let mut guard = SHARED.lock().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(Shared::default))
}

fn snapshot_flag(key: &str) -> bool {
    with_shared(|s| s.snapshot.as_ref().and_then(|v| v.get(key)).and_then(Value::as_bool).unwrap_or(false))
}

fn snapshot_claims() -> u64 {
    with_shared(|s| s.snapshot.as_ref().and_then(|v| v.get("claims")).and_then(Value::as_u64).unwrap_or(0))
}

pub fn setup_tray<R: Runtime>(app: &AppHandle<R>, state: Arc<AppState>) -> tauri::Result<()> {
    let open = MenuItemBuilder::with_id("open", "Open 0xio Desktop").build(app)?;
    let quit_item = MenuItemBuilder::with_id("quit", "Quit 0xio Desktop").build(app)?;
    let menu = MenuBuilder::new(app)
        .item(&open)
        .item(&PredefinedMenuItem::separator(app)?)
        .item(&quit_item)
        .build()?;

    let tray = TrayIconBuilder::with_id(TRAY_ID)
        .icon(Image::from_bytes(ICON_PLAIN)?)
        .icon_as_template(true)
        .tooltip("0xio Desktop")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main(app, None),
            "quit" => {
                tlog!("[tray] Quit requested");
                quit(app);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, rect, .. } = event {
                toggle_panel(tray.app_handle(), rect);
            }
        })
        .build(app)?;
    *state.tray_handle.lock().unwrap() = Some(Box::new(tray));

    let handle = app.clone();
    app.listen_any("ws-computing-changed", move |_| refresh_icon(&handle));

    tlog!("[tray] Tray icon created");
    Ok(())
}

fn refresh_icon<R: Runtime>(app: &AppHandle<R>) {
    let computing = app.state::<Arc<AppState>>().is_computing();
    if computing {
        start_animation(app);
        return;
    }
    let locked = snapshot_flag("locked");
    if locked {
        show_icon(app, KEY_LOCKED, ICON_LOCKED);
    } else {
        show_icon(app, KEY_PLAIN, ICON_PLAIN);
    }
    let claims = snapshot_claims();
    let sites = with_shared(|s| s.site_waiting);
    let title = menu_title(sites, locked, claims);
    if with_shared(|s| std::mem::replace(&mut s.shown_title, title.clone()) == title) {
        return;
    }
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_title(title);
    }
}

fn menu_title(sites: usize, locked: bool, claims: u64) -> Option<String> {
    if sites > 0 {
        Some(sites.to_string())
    } else if !locked && claims > 0 {
        Some(claims.to_string())
    } else {
        None
    }
}

pub fn set_site_count<R: Runtime>(app: &AppHandle<R>, count: usize) {
    if with_shared(|s| std::mem::replace(&mut s.site_waiting, count)) == count {
        return;
    }
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || refresh_icon(&app2));
}

pub fn open_for_site<R: Runtime>(app: &AppHandle<R>, id: Option<String>, site: Option<String>) {
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        if with_shared(|s| s.icon_rect.is_none()) {
            if let Some(rect) = app2.tray_by_id(TRAY_ID).and_then(|t| t.rect().ok().flatten()) {
                with_shared(|s| s.icon_rect = Some(rect));
            }
        }
        let Ok(window) = panel(&app2) else { return };
        place(&window);
        present(&window);
        crate::sites::site_relay::clear_notices(&app2.state::<Arc<AppState>>());
        tlog!("[tray] panel opened for a site request");
        let _ = app2.emit_to(TRAY_WINDOW, "site-focus", json!({ "id": id, "origin": site }));
        let _ = app2.emit_to(TRAY_WINDOW, "tray-opened", ());
        let _ = app2.emit_to("main", "tray-opened", ());
    });
}

fn show_icon<R: Runtime>(app: &AppHandle<R>, key: usize, bytes: &'static [u8]) {
    if with_shared(|s| std::mem::replace(&mut s.shown_icon, Some(key)) == Some(key)) {
        return;
    }
    let Some(tray) = app.tray_by_id(TRAY_ID) else { return };
    #[cfg(target_os = "macos")]
    {
        // tray-icon's set_icon first draws the image as a plain picture at its pixel size, then
        // set_icon_as_template redraws it as a glyph: a visible flash on every frame. Build the
        // final image here and set it once.
        let _ = tray.with_inner_tray_icon(move |inner| {
            use objc2::AllocAnyThread;
            use objc2_app_kit::NSImage;
            use objc2_foundation::{NSData, NSSize};
            let Some(item) = inner.ns_status_item() else { return };
            let Some(mtm) = objc2::MainThreadMarker::new() else { return };
            let Some(button) = item.button(mtm) else { return };
            let data = NSData::with_bytes(bytes);
            let Some(image) = NSImage::initWithData(NSImage::alloc(), &data) else { return };
            image.setSize(NSSize::new(18.0, 18.0));
            image.setTemplate(true);
            button.setImage(Some(&image));
        });
    }
    #[cfg(not(target_os = "macos"))]
    if let Ok(img) = Image::from_bytes(bytes) {
        let _ = tray.set_icon(Some(img));
    }
}


fn start_animation<R: Runtime>(app: &AppHandle<R>) {
    if ANIMATING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        while app.state::<Arc<AppState>>().is_computing() {
            let f = FRAME.fetch_add(1, Ordering::Relaxed) % ICON_WORKING.len();
            show_icon(&app, f, ICON_WORKING[f]);
            std::thread::sleep(Duration::from_millis(90));
        }
        ANIMATING.store(false, Ordering::SeqCst);
        refresh_icon(&app);
    });
}

static CLOSE_HELD: AtomicBool = AtomicBool::new(false);

/// The wallet UI keeps the window open while it asks what to do with unsaved contract files.
#[tauri::command]
pub fn main_close_hold<R: Runtime>(webview: Webview<R>, held: bool) -> Result<(), String> {
    require_main(&webview)?;
    CLOSE_HELD.store(held, Ordering::SeqCst);
    Ok(())
}

pub fn close_held() -> bool {
    CLOSE_HELD.load(Ordering::SeqCst)
}

/// The only real quit: the tray menu and the panel. Everything else closes to the menu bar.
pub fn quit<R: Runtime>(app: &AppHandle<R>) {
    QUITTING.store(true, Ordering::SeqCst);
    app.exit(0);
}

pub fn quit_requested() -> bool {
    QUITTING.load(Ordering::SeqCst)
}

/// Close the main window to the menu bar. Its webview keeps running and owns wallet state.
pub fn hide_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    set_dock_visible(app, false);
    tlog!("[0xio-desktop] Window closed to the menu bar");
}

pub fn set_dock_visible<R: Runtime>(app: &AppHandle<R>, visible: bool) {
    #[cfg(target_os = "macos")]
    {
        let policy = if visible { tauri::ActivationPolicy::Regular } else { tauri::ActivationPolicy::Accessory };
        let _ = app.set_activation_policy(policy);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, visible);
}

pub fn show_main<R: Runtime>(app: &AppHandle<R>, route: Option<String>) {
    tlog!("[0xio-desktop] Window shown");
    if let Some(panel) = app.get_webview_window(TRAY_WINDOW) {
        hide_panel(app, &panel);
    }
    set_dock_visible(app, true);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    if let Some(route) = route {
        let _ = app.emit_to("main", "tray-action", json!({ "type": "navigate", "route": route }));
    }
}

fn hide_panel<R: Runtime>(app: &AppHandle<R>, panel: &WebviewWindow<R>) {
    let _ = panel.hide();
    let _ = app.emit_to("main", "tray-closed", ());
}

pub fn close_panel<R: Runtime>(app: &AppHandle<R>) {
    if let Some(panel) = app.get_webview_window(TRAY_WINDOW) {
        hide_panel(app, &panel);
    }
}

fn panel<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<WebviewWindow<R>> {
    if let Some(w) = app.get_webview_window(TRAY_WINDOW) {
        return Ok(w);
    }
    let window = WebviewWindowBuilder::new(app, TRAY_WINDOW, WebviewUrl::App("tray.html".into()))
        .title("0xio Desktop")
        .inner_size(PANEL_W, PANEL_H)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .focused(false)
        .build()?;
    float_over_everything(&window);
    let app2 = app.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::Focused(false) = event {
            let held = with_shared(|s| {
                let on = s.auth_hold_until.is_some_and(|t| Instant::now() < t);
                s.blurred_in_hold |= on;
                on
            });
            tlog!("[tray] panel lost focus (auth hold: {})", held);
            if held {
                return;
            }
            if let Some(w) = app2.get_webview_window(TRAY_WINDOW) {
                hide_panel(&app2, &w);
                with_shared(|s| s.hidden_at = Some(Instant::now()));
            }
        }
    });
    Ok(window)
}

// A borderless NSPanel subclass that can take keyboard focus (borderless windows refuse it by
// default), for the password field.
#[cfg(target_os = "macos")]
objc2::define_class!(
    // Safety: NSPanel has no subclassing requirements; no ivars, no Drop.
    #[unsafe(super(objc2_app_kit::NSPanel, objc2_app_kit::NSWindow, objc2_app_kit::NSResponder, objc2::runtime::NSObject))]
    #[thread_kind = objc2::MainThreadOnly]
    #[name = "OxioTrayPanel"]
    struct TrayPanel;

    impl TrayPanel {
        #[unsafe(method(canBecomeKeyWindow))]
        fn can_become_key_window(&self) -> bool {
            true
        }

        #[unsafe(method(canBecomeMainWindow))]
        fn can_become_main_window(&self) -> bool {
            false
        }
    }
);

/// macOS: turn the window into a non-activating panel at menu level that joins every Space,
/// full-screen ones included. Opening it then never activates the app, so macOS does not switch
/// to the Space with the main window (which also blurred and hid the panel at once). Another
/// app's full-screen Space takes the panel only with CanJoinAllApplications (macOS 13+).
#[cfg(target_os = "macos")]
fn float_over_everything<R: Runtime>(window: &WebviewWindow<R>) {
    use objc2::ClassType;
    use objc2_app_kit::{NSPanel, NSWindowStyleMask};
    let Ok(ptr) = window.ns_window() else { return };
    // Safety: Tauri hands back the live NSWindow of this webview window, and this runs on the
    // main thread. TrayPanel adds no ivars, so swapping the class keeps the object layout.
    let ns: &NSPanel = unsafe {
        objc2::ffi::object_setClass(ptr as *mut objc2::runtime::AnyObject, TrayPanel::class());
        &*(ptr as *const NSPanel)
    };
    ns.setStyleMask(ns.styleMask() | NSWindowStyleMask::NonactivatingPanel);
    ns.setCollectionBehavior(panel_behavior());
    ns.setFloatingPanel(true);
    ns.setHidesOnDeactivate(false);
    // NSPopUpMenuWindowLevel: above full-screen windows, like a menu.
    ns.setLevel(101);
    add_glass(ns);
}

/// macOS: real glass under the transparent webview. Liquid Glass (NSGlassEffectView) on macOS 26,
/// the popover material before it. The webview only sees itself, so the glass must be native.
#[cfg(target_os = "macos")]
fn add_glass(ns: &objc2_app_kit::NSPanel) {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};
    let Some(content) = ns.contentView() else { return };
    let frame = content.bounds();
    let glass = AnyClass::get(c"NSGlassEffectView");
    let Some(class) = glass.or_else(|| AnyClass::get(c"NSVisualEffectView")) else { return };
    // Safety: plain AppKit view setup on the main thread; the view is retained by its superview.
    unsafe {
        let alloc: objc2::rc::Allocated<AnyObject> = msg_send![class, alloc];
        let Some(view): Option<objc2::rc::Retained<AnyObject>> = msg_send![alloc, initWithFrame: frame] else {
            return;
        };
        let view = &*view;
        if glass.is_some() {
            // NSGlassEffectViewStyleClear: the more refractive of the two.
            let _: () = msg_send![view, setStyle: 1isize];
            let _: () = msg_send![view, setCornerRadius: PANEL_RADIUS];
        } else {
            // Popover material, blending with what is behind the window, always active.
            let _: () = msg_send![view, setMaterial: 6isize];
            let _: () = msg_send![view, setBlendingMode: 0isize];
            let _: () = msg_send![view, setState: 1isize];
            let _: () = msg_send![view, setWantsLayer: true];
            let layer: *mut AnyObject = msg_send![view, layer];
            if !layer.is_null() {
                let _: () = msg_send![layer, setCornerRadius: PANEL_RADIUS];
                let _: () = msg_send![layer, setMasksToBounds: true];
            }
        }
        // NSViewWidthSizable | NSViewHeightSizable
        let _: () = msg_send![view, setAutoresizingMask: 18usize];
        // NSWindowBelow: under the webview.
        let _: () = msg_send![&*content, addSubview: view, positioned: -1isize, relativeTo: std::ptr::null::<AnyObject>()];
    }
}

#[cfg(target_os = "macos")]
fn panel_behavior() -> objc2_app_kit::NSWindowCollectionBehavior {
    use objc2_app_kit::NSWindowCollectionBehavior as B;
    let mut behavior = B::CanJoinAllSpaces | B::FullScreenAuxiliary | B::Stationary | B::IgnoresCycle;
    if objc2::available!(macos = 13.0) {
        behavior |= B::CanJoinAllApplications;
    }
    behavior
}

/// The same flags, but the window moves to the Space in view when it is ordered front.
#[cfg(target_os = "macos")]
fn follow_behavior() -> objc2_app_kit::NSWindowCollectionBehavior {
    use objc2_app_kit::NSWindowCollectionBehavior as B;
    panel_behavior().difference(B::CanJoinAllSpaces | B::Stationary) | B::MoveToActiveSpace
}

/// A panel that has been open before can stay on the Space it was first shown on (seen after a
/// while in full-screen Spaces: shown and keyed, but on another desktop, so a click shows
/// nothing until a restart). Setting the flags again before a show makes macOS place it anew.
#[cfg(target_os = "macos")]
fn rejoin_spaces(ns: &objc2_app_kit::NSWindow) {
    ns.setCollectionBehavior(follow_behavior());
    ns.setCollectionBehavior(panel_behavior());
}

#[cfg(target_os = "macos")]
fn move_here(ns: &objc2_app_kit::NSWindow) {
    tlog!("[tray] panel opened on another desktop (flags {:#x}), moving it here", ns.collectionBehavior().bits());
    ns.setCollectionBehavior(follow_behavior());
    ns.makeKeyAndOrderFront(None);
    ns.setCollectionBehavior(panel_behavior());
}

#[cfg(not(target_os = "macos"))]
fn float_over_everything<R: Runtime>(_window: &WebviewWindow<R>) {}

fn on_active_space<R: Runtime>(window: &WebviewWindow<R>) -> bool {
    #[cfg(target_os = "macos")]
    {
        if let Ok(ptr) = window.ns_window() {
            // Safety: live NSWindow of this webview window, on the main thread.
            let ns: &objc2_app_kit::NSWindow = unsafe { &*(ptr as *const objc2_app_kit::NSWindow) };
            return ns.isOnActiveSpace();
        }
    }
    let _ = window;
    true
}

fn present<R: Runtime>(window: &WebviewWindow<R>) {
    #[cfg(target_os = "macos")]
    {
        let Ok(ptr) = window.ns_window() else {
            let _ = window.show();
            return;
        };
        // Safety: live NSWindow of this webview window, on the main thread.
        let ns: &objc2_app_kit::NSWindow = unsafe { &*(ptr as *const objc2_app_kit::NSWindow) };
        rejoin_spaces(ns);
        let _ = window.show();
        ns.makeKeyAndOrderFront(None);
        if !ns.isOnActiveSpace() {
            move_here(ns);
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[derive(Debug, PartialEq)]
enum Toggle {
    Hide,
    Show,
    Ignore,
}

/// What an icon click does. Only a panel that is open, on this desktop and frontmost closes;
/// one open elsewhere, or left open without focus, comes here on top. The click that closed the
/// panel by taking its focus also lands here and must not reopen it.
fn toggle_action(visible: bool, here: bool, key: bool, just_hidden: bool) -> Toggle {
    if visible && here && key {
        Toggle::Hide
    } else if just_hidden {
        Toggle::Ignore
    } else {
        Toggle::Show
    }
}

fn toggle_panel<R: Runtime>(app: &AppHandle<R>, rect: Rect) {
    with_shared(|s| s.icon_rect = Some(rect));
    let Ok(window) = panel(app) else { return };
    let visible = window.is_visible().unwrap_or(false);
    let here = on_active_space(&window);
    let key = window.is_focused().unwrap_or(false);
    let just_hidden = with_shared(|s| s.hidden_at.is_some_and(|t| t.elapsed() < Duration::from_millis(250)));
    let action = toggle_action(visible, here, key, just_hidden);
    tlog!("[tray] icon click (open: {}, on this desktop: {}, focused: {}) -> {:?}", visible, here, key, action);
    match action {
        Toggle::Hide => {
            hide_panel(app, &window);
            return;
        }
        Toggle::Ignore => return,
        Toggle::Show => {}
    }
    place(&window);
    present(&window);
    crate::sites::site_relay::clear_notices(&app.state::<Arc<AppState>>());
    tlog!("[tray] panel shown (on this desktop: {})", on_active_space(&window));
    let _ = app.emit_to(TRAY_WINDOW, "tray-opened", ());
    let _ = app.emit_to("main", "tray-opened", ());
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Bounds {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

impl Bounds {
    fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && x < self.x + self.w && y >= self.y && y < self.y + self.h
    }
}

fn panel_origin(icon: Bounds, screen: Bounds, panel: (f64, f64), margin: f64, gap: f64) -> (f64, f64) {
    let x = (icon.x + icon.w / 2.0 - panel.0 / 2.0)
        .min(screen.x + screen.w - panel.0 - margin)
        .max(screen.x + margin);
    let below = icon.y < screen.y + screen.h / 2.0;
    let y = if below { icon.y + icon.h + gap } else { icon.y - panel.1 - gap };
    (x, y)
}

/// The units screens are compared in: points on macOS, where every screen has its own scale and
/// pixel positions do not line up across them, pixels elsewhere.
fn screen_unit(scale: f64) -> f64 {
    if cfg!(target_os = "macos") { scale } else { 1.0 }
}

fn screen_bounds(m: &Monitor) -> Bounds {
    let u = screen_unit(m.scale_factor());
    Bounds {
        x: m.position().x as f64 / u,
        y: m.position().y as f64 / u,
        w: m.size().width as f64 / u,
        h: m.size().height as f64 / u,
    }
}

/// The icon in screen units. The click reports it in the pixels of the screen it sits on.
fn icon_bounds(rect: Rect, m: &Monitor) -> Bounds {
    let s = m.scale_factor();
    let u = screen_unit(s);
    let pos = rect.position.to_physical::<f64>(s);
    let size = rect.size.to_physical::<f64>(s);
    Bounds { x: pos.x / u, y: pos.y / u, w: size.width / u, h: size.height / u }
}

fn place<R: Runtime>(window: &WebviewWindow<R>) {
    let Some(rect) = with_shared(|s| s.icon_rect) else { return };
    let monitors = window.available_monitors().unwrap_or_default();
    let screens: Vec<Bounds> = monitors.iter().map(screen_bounds).collect();
    // macOS reports the cursor in points scaled by the primary screen.
    let cursor_unit = window
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| screen_unit(m.scale_factor()))
        .unwrap_or(1.0);
    let clicked = window
        .cursor_position()
        .ok()
        .and_then(|p| screens.iter().position(|b| b.contains(p.x / cursor_unit, p.y / cursor_unit)))
        .or_else(|| {
            monitors.iter().zip(&screens).position(|(m, b)| {
                let icon = icon_bounds(rect, m);
                b.contains(icon.x + icon.w / 2.0, icon.y + icon.h / 2.0)
            })
        });
    let Some(i) = clicked else { return };
    let m = &monitors[i];
    let k = m.scale_factor() / screen_unit(m.scale_factor());
    let (x, y) = panel_origin(icon_bounds(rect, m), screens[i], (PANEL_W * k, PANEL_H * k), 8.0 * k, GAP * k);
    let _ = if cfg!(target_os = "macos") {
        window.set_position(LogicalPosition::new(x, y))
    } else {
        window.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32))
    };
}

/// Main window: the state the panel shows. Opaque to Rust apart from `locked` and `claims`.
#[tauri::command]
pub fn tray_publish<R: Runtime>(webview: Webview<R>, app: AppHandle<R>, snapshot: Value) -> Result<(), String> {
    require_main(&webview)?;
    with_shared(|s| s.snapshot = Some(snapshot.clone()));
    let _ = app.emit_to(TRAY_WINDOW, "tray-state", snapshot);
    refresh_icon(&app);
    Ok(())
}

#[tauri::command]
pub fn tray_progress<R: Runtime>(webview: Webview<R>, app: AppHandle<R>, progress: Value) -> Result<(), String> {
    require_main(&webview)?;
    let _ = app.emit_to(TRAY_WINDOW, "tray-progress", progress);
    Ok(())
}

#[tauri::command]
pub fn tray_get_state<R: Runtime>(webview: Webview<R>, app: AppHandle<R>) -> Result<Value, String> {
    require_tray(&webview)?;
    let state = app.state::<Arc<AppState>>();
    Ok(json!({
        "snapshot": with_shared(|s| s.snapshot.clone()),
        "clients": state.connected_clients(),
        "computing": state.is_computing(),
        "computingExtension": state.is_ext_computing(),
        "openAtLogin": autostart::is_enabled(),
    }))
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TrayAction {
    #[serde(rename_all = "camelCase")]
    SwitchWallet { id: String },
    #[serde(rename_all = "camelCase")]
    SetNetwork { id: String },
    Lock,
    UnlockBiometric,
    #[serde(rename_all = "camelCase")]
    OpenApp { route: Option<String> },
    #[serde(rename_all = "camelCase")]
    Send { request_id: String, to: String, amount_micro: u64, mode: String, fee_ou: u64, wallet_id: String, network: String },
    #[serde(rename_all = "camelCase")]
    Private {
        request_id: String,
        direction: String,
        amount_micro: u64,
        refresh: bool,
        fee_ou: u64,
        refresh_fee_ou: u64,
        wallet_id: String,
        network: String,
    },
    #[serde(rename_all = "camelCase")]
    Refresh { request_id: String, wallet_id: String, network: String, fee_ou: u64 },
    #[serde(rename_all = "camelCase")]
    TurnOn { request_id: String, wallet_id: String, network: String, fee_ou: u64 },
    #[serde(rename_all = "camelCase")]
    Migrate {
        request_id: String,
        wallet_id: String,
        network: String,
        mode: String,
        amount_micro: u64,
        fee_ou: u64,
        confirmed: bool,
    },
    #[serde(rename_all = "camelCase")]
    CancelSend { request_id: String },
    RetryReads,
    #[serde(rename_all = "camelCase")]
    SetOpenAtLogin { enabled: bool },
    Quit,
}

const ROUTES: &[&str] = &["/", "/send", "/receive", "/privacy", "/privacy?tab=claim", "/settings", "/lock"];

fn short(text: &str, max: usize) -> Result<(), String> {
    if text.is_empty() || text.len() > max || !text.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("Invalid request".into());
    }
    Ok(())
}

fn send_request(
    request_id: &str,
    to: &str,
    amount_micro: u64,
    mode: &str,
    fee_ou: u64,
    wallet_id: &str,
    network: &str,
) -> Result<Value, String> {
    short(request_id, 64)?;
    short(wallet_id, 64)?;
    short(network, 64)?;
    if to.is_empty() || to.len() > 128 || !to.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("That address does not look right".into());
    }
    if amount_micro == 0 || fee_ou == 0 || (mode != "public" && mode != "private") {
        return Err("Invalid request".into());
    }
    Ok(json!({ "type": "send", "requestId": request_id, "to": to, "amountMicro": amount_micro, "mode": mode, "feeOu": fee_ou, "walletId": wallet_id, "network": network }))
}

fn key_request(kind: &str, request_id: &str, wallet_id: &str, network: &str, fee_ou: u64) -> Result<Value, String> {
    short(request_id, 64)?;
    short(wallet_id, 64)?;
    short(network, 64)?;
    if fee_ou == 0 {
        return Err("Invalid request".into());
    }
    Ok(json!({ "type": kind, "requestId": request_id, "walletId": wallet_id, "network": network, "feeOu": fee_ou }))
}

const KEY_UPDATE_MODES: &[(&str, bool)] = &[
    ("empty_key_switch", false),
    ("legacy_zero_reset", false),
    ("legacy_public_migration", true),
    ("key_bound_migration", true),
];

fn migrate_request(
    request_id: &str,
    wallet_id: &str,
    network: &str,
    mode: &str,
    amount_micro: u64,
    fee_ou: u64,
    confirmed: bool,
) -> Result<Value, String> {
    let mut v = key_request("migrate", request_id, wallet_id, network, fee_ou)?;
    let Some(&(_, moves)) = KEY_UPDATE_MODES.iter().find(|(m, _)| *m == mode) else {
        return Err("Invalid request".into());
    };
    if !confirmed || (!moves && amount_micro != 0) {
        return Err("Invalid request".into());
    }
    v["mode"] = json!(mode);
    v["amountMicro"] = json!(amount_micro);
    v["confirmed"] = json!(true);
    Ok(v)
}

#[tauri::command]
pub fn tray_action<R: Runtime>(webview: Webview<R>, app: AppHandle<R>, action: TrayAction) -> Result<Value, String> {
    require_tray(&webview)?;
    let forward = |payload: Value| {
        app.emit_to("main", "tray-action", payload).map_err(|e| e.to_string())?;
        Ok(json!({ "ok": true }))
    };
    match action {
        TrayAction::SwitchWallet { id } => {
            short(&id, 64)?;
            forward(json!({ "type": "switchWallet", "id": id }))
        }
        TrayAction::SetNetwork { id } => {
            short(&id, 64)?;
            forward(json!({ "type": "setNetwork", "id": id }))
        }
        TrayAction::Lock => forward(json!({ "type": "lock" })),
        TrayAction::UnlockBiometric => forward(json!({ "type": "unlockBiometric" })),
        TrayAction::OpenApp { route } => {
            let route = route.filter(|r| ROUTES.contains(&r.as_str()));
            show_main(&app, route);
            Ok(json!({ "ok": true }))
        }
        TrayAction::Send { request_id, to, amount_micro, mode, fee_ou, wallet_id, network } => {
            forward(send_request(&request_id, &to, amount_micro, &mode, fee_ou, &wallet_id, &network)?)
        }
        TrayAction::Private { request_id, direction, amount_micro, refresh, fee_ou, refresh_fee_ou, wallet_id, network } => {
            short(&request_id, 64)?;
            short(&wallet_id, 64)?;
            short(&network, 64)?;
            if amount_micro == 0 || fee_ou == 0 || (refresh && refresh_fee_ou == 0) {
                return Err("Invalid request".into());
            }
            if direction != "encrypt" && direction != "decrypt" {
                return Err("Invalid request".into());
            }
            forward(json!({ "type": "private", "requestId": request_id, "direction": direction, "amountMicro": amount_micro, "refresh": refresh, "feeOu": fee_ou, "refreshFeeOu": refresh_fee_ou, "walletId": wallet_id, "network": network }))
        }
        TrayAction::Refresh { request_id, wallet_id, network, fee_ou } => {
            forward(key_request("refresh", &request_id, &wallet_id, &network, fee_ou)?)
        }
        TrayAction::TurnOn { request_id, wallet_id, network, fee_ou } => {
            forward(key_request("turnOn", &request_id, &wallet_id, &network, fee_ou)?)
        }
        TrayAction::Migrate { request_id, wallet_id, network, mode, amount_micro, fee_ou, confirmed } => {
            forward(migrate_request(&request_id, &wallet_id, &network, &mode, amount_micro, fee_ou, confirmed)?)
        }
        TrayAction::CancelSend { request_id } => {
            short(&request_id, 64)?;
            forward(json!({ "type": "cancelSend", "requestId": request_id }))
        }
        TrayAction::RetryReads => forward(json!({ "type": "retryReads" })),
        TrayAction::SetOpenAtLogin { enabled } => {
            autostart::set_enabled(enabled)?;
            Ok(json!({ "openAtLogin": autostart::is_enabled() }))
        }
        TrayAction::Quit => {
            tlog!("[tray] Quit from panel");
            quit(&app);
            Ok(json!({ "ok": true }))
        }
    }
}

/// Panel: unlock with the password. Same rate-limited path as the lock screen; the main window
/// receives only the wallet list.
#[tauri::command]
pub async fn tray_unlock<R: Runtime>(webview: Webview<R>, app: AppHandle<R>, password: String) -> Result<(), String> {
    require_tray(&webview)?;
    let wallets = crate::wallet::wallet_commands::unlock_with_password(&app, password)?;
    app.emit_to("main", "tray-unlocked", wallets).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn tray_approve_send<R: Runtime>(
    webview: Webview<R>,
    app: AppHandle<R>,
    request_id: String,
    password: String,
) -> Result<(), String> {
    require_tray(&webview)?;
    short(&request_id, 64)?;
    crate::wallet::wallet_commands::unlock_with_password(&app, password)?;
    app.emit_to("main", "tray-action", json!({ "type": "sendApproved", "requestId": request_id }))
        .map_err(|e| e.to_string())
}

/// Holds the panel open while a Touch ID prompt has focus, then keys it again. macOS hands focus
/// back to the previous app a moment after the prompt, so the hold outlives it by AUTH_GRACE.
#[tauri::command]
pub fn tray_auth_hold<R: Runtime>(webview: Webview<R>, app: AppHandle<R>, on: bool) -> Result<(), String> {
    require_main(&webview)?;
    tlog!("[tray] auth hold {}", if on { "on" } else { "off" });
    if on {
        with_shared(|s| {
            s.auth_hold_until = Some(Instant::now() + AUTH_HOLD_MAX);
            s.blurred_in_hold = false;
        });
        return Ok(());
    }
    with_shared(|s| s.auth_hold_until = Some(Instant::now() + AUTH_GRACE));
    std::thread::spawn(move || {
        for wait in REKEY_AFTER {
            std::thread::sleep(wait);
            let app2 = app.clone();
            let _ = app.run_on_main_thread(move || {
                if !with_shared(|s| std::mem::take(&mut s.blurred_in_hold)) {
                    return;
                }
                if let Some(w) = app2.get_webview_window(TRAY_WINDOW) {
                    if w.is_visible().unwrap_or(false) {
                        tlog!("[tray] panel keyed again after Touch ID");
                        present(&w);
                    }
                }
            });
        }
    });
    Ok(())
}

#[tauri::command]
pub fn tray_hide<R: Runtime>(webview: Webview<R>, app: AppHandle<R>) -> Result<(), String> {
    require_tray(&webview)?;
    close_panel(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_panel_is_hidden_in_one_place_that_tells_the_main_window() {
        let source = include_str!("tray.rs");
        let code = source.split("#[cfg(test)]\nmod tests").next().unwrap();
        let hides: Vec<&str> = code.lines().filter(|l| l.contains("panel.hide()")).collect();
        assert_eq!(hides.len(), 1);
        let body = code.split("fn hide_panel<R: Runtime>").nth(1).unwrap().split("\n}\n").next().unwrap();
        assert!(body.contains("panel.hide()") && body.contains("\"tray-closed\""));
        let window_events = include_str!("../lib.rs").split(".on_window_event(").nth(1).unwrap().split(".on_menu_event(").next().unwrap();
        assert!(window_events.contains("tray::close_panel("));
        let capability = include_str!("../../capabilities/tray.json");
        assert!(!capability.contains("core:window:allow-hide"));
        assert!(include_str!("../../permissions/tray-window.toml").contains("allow-tray-hide"));
    }

    #[test]
    fn waiting_site_requests_take_the_count() {
        assert_eq!(menu_title(2, false, 5).as_deref(), Some("2"));
        assert_eq!(menu_title(1, true, 0).as_deref(), Some("1"));
        assert_eq!(menu_title(0, false, 5).as_deref(), Some("5"));
        assert_eq!(menu_title(0, true, 5), None);
        assert_eq!(menu_title(0, false, 0), None);
    }

    #[test]
    fn icon_click_hides_only_a_frontmost_panel_on_this_desktop() {
        assert_eq!(toggle_action(true, true, true, false), Toggle::Hide);
        assert_eq!(toggle_action(true, false, true, false), Toggle::Show);
        assert_eq!(toggle_action(true, false, false, false), Toggle::Show);
        assert_eq!(toggle_action(true, true, false, false), Toggle::Show);
        assert_eq!(toggle_action(false, true, false, false), Toggle::Show);
        assert_eq!(toggle_action(false, false, false, false), Toggle::Show);
    }

    #[test]
    fn icon_click_that_just_closed_the_panel_does_not_reopen_it() {
        assert_eq!(toggle_action(false, true, false, true), Toggle::Ignore);
        assert_eq!(toggle_action(true, true, true, true), Toggle::Hide);
    }

    #[test]
    fn panel_sits_under_the_icon_inside_its_screen() {
        let screen = Bounds { x: 1440.0, y: 0.0, w: 1920.0, h: 1080.0 };
        let icon = Bounds { x: 2400.0, y: 0.0, w: 24.0, h: 24.0 };
        assert_eq!(panel_origin(icon, screen, (320.0, 404.0), 8.0, 6.0), (2252.0, 30.0));
        let edge = Bounds { x: 3350.0, ..icon };
        assert_eq!(panel_origin(edge, screen, (320.0, 404.0), 8.0, 6.0).0, 3032.0);
        let bottom = Bounds { y: 1056.0, ..icon };
        assert_eq!(panel_origin(bottom, screen, (320.0, 404.0), 8.0, 6.0).1, 646.0);
    }

    #[test]
    fn panel_keeps_to_a_screen_narrower_than_it() {
        let screen = Bounds { x: 0.0, y: 0.0, w: 300.0, h: 600.0 };
        let icon = Bounds { x: 280.0, y: 0.0, w: 20.0, h: 20.0 };
        assert_eq!(panel_origin(icon, screen, (320.0, 404.0), 8.0, 6.0).0, 8.0);
    }

    #[test]
    fn screen_holds_the_point_on_its_own_side_only() {
        let left = Bounds { x: 0.0, y: 0.0, w: 1440.0, h: 900.0 };
        let right = Bounds { x: 1440.0, y: -200.0, w: 1920.0, h: 1080.0 };
        assert!(left.contains(1439.0, 10.0));
        assert!(!left.contains(1440.0, 10.0));
        assert!(right.contains(1440.0, -150.0));
        assert!(!right.contains(1440.0, 880.0));
    }

    #[test]
    fn send_request_forwards_the_reviewed_fee() {
        let v = send_request("req-1", "octABC", 5, "private", 1_000_000, "w_1", "devnet").unwrap();
        assert_eq!(v["type"], "send");
        assert_eq!(v["feeOu"], 1_000_000);
        assert_eq!(v["mode"], "private");
        assert_eq!(v["network"], "devnet");
    }

    #[test]
    fn send_request_refuses_a_missing_fee() {
        assert!(send_request("req-1", "octABC", 5, "public", 0, "w_1", "devnet").is_err());
        assert!(send_request("req-1", "oct-ABC", 5, "public", 1, "w_1", "devnet").is_err());
    }

    #[test]
    fn key_request_forwards_the_reviewed_fee() {
        let v = key_request("refresh", "req-1", "w_1", "devnet", 2_000_000).unwrap();
        assert_eq!(v["type"], "refresh");
        assert_eq!(v["requestId"], "req-1");
        assert_eq!(v["walletId"], "w_1");
        assert_eq!(v["network"], "devnet");
        assert_eq!(v["feeOu"], 2_000_000);
    }

    #[test]
    fn key_request_refuses_a_zero_fee() {
        assert!(key_request("turnOn", "req-1", "w1", "mainnet", 0).is_err());
    }

    #[test]
    fn key_request_refuses_bad_ids() {
        assert!(key_request("refresh", "", "w1", "mainnet", 1).is_err());
        assert!(key_request("refresh", "req 1", "w1", "mainnet", 1).is_err());
        assert!(key_request("refresh", "req1", &"w".repeat(65), "mainnet", 1).is_err());
        assert!(key_request("turnOn", "req1", "w1", "main/net", 1).is_err());
    }

    #[test]
    fn migrate_request_forwards_the_reviewed_update() {
        let v = migrate_request("r1", "w1", "devnet", "key_bound_migration", 12_500_000, 1_000_000, true).unwrap();
        assert_eq!(v["type"], "migrate");
        assert_eq!(v["mode"], "key_bound_migration");
        assert_eq!(v["amountMicro"], 12_500_000);
        assert_eq!(v["feeOu"], 1_000_000);
        assert_eq!(v["confirmed"], true);
        let k = migrate_request("r1", "w1", "devnet", "empty_key_switch", 0, 1_000_000, true).unwrap();
        assert_eq!(k["amountMicro"], 0);
    }

    #[test]
    fn migrate_request_refuses_what_the_review_could_not_show() {
        assert!(migrate_request("r1", "w1", "devnet", "key_bound_migration", 1, 1_000, false).is_err());
        assert!(migrate_request("r1", "w1", "devnet", "bare_rotation", 0, 1_000, true).is_err());
        assert!(migrate_request("r1", "w1", "devnet", "empty_key_switch", 5, 1_000, true).is_err());
        assert!(migrate_request("r1", "w1", "devnet", "legacy_zero_reset", 5, 1_000, true).is_err());
        assert!(migrate_request("r1", "w1", "devnet", "legacy_public_migration", 5, 0, true).is_err());
        assert!(migrate_request("r 1", "w1", "devnet", "legacy_public_migration", 5, 1_000, true).is_err());
    }

    #[test]
    fn panel_actions_parse() {
        let m: TrayAction = serde_json::from_value(json!({
            "type": "migrate", "requestId": "r", "walletId": "w", "network": "devnet",
            "mode": "legacy_public_migration", "amountMicro": 9, "feeOu": 3, "confirmed": true
        }))
        .unwrap();
        assert!(matches!(m, TrayAction::Migrate { fee_ou: 3, amount_micro: 9, confirmed: true, .. }));
        let a: TrayAction = serde_json::from_value(json!({
            "type": "turnOn", "requestId": "r", "walletId": "w", "network": "devnet", "feeOu": 5
        }))
        .unwrap();
        assert!(matches!(a, TrayAction::TurnOn { fee_ou: 5, .. }));
        let b: TrayAction = serde_json::from_value(json!({
            "type": "refresh", "requestId": "r", "walletId": "w", "network": "devnet", "feeOu": 7
        }))
        .unwrap();
        assert!(matches!(b, TrayAction::Refresh { fee_ou: 7, .. }));
        let c: TrayAction = serde_json::from_value(json!({
            "type": "send", "requestId": "r", "to": "octA", "amountMicro": 1, "mode": "public",
            "feeOu": 9, "walletId": "w", "network": "devnet"
        }))
        .unwrap();
        assert!(matches!(c, TrayAction::Send { fee_ou: 9, .. }));
        assert!(serde_json::from_value::<TrayAction>(json!({
            "type": "send", "requestId": "r", "to": "octA", "amountMicro": 1, "mode": "public",
            "walletId": "w", "network": "devnet"
        }))
        .is_err());
        let d: TrayAction = serde_json::from_value(json!({ "type": "retryReads" })).unwrap();
        assert!(matches!(d, TrayAction::RetryReads));
    }
}
