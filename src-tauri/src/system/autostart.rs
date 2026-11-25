//! Open at login without a plugin. macOS: a per-user LaunchAgent. Windows: the per-user Run key.
//! Both start the app with HIDDEN_ARG so it opens in the menu bar instead of showing the window.

pub const HIDDEN_ARG: &str = "--hidden";

#[cfg(target_os = "macos")]
const LABEL: &str = "com.0xio.desktop.login";

#[cfg(target_os = "macos")]
fn agent_path() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME").map(|home| {
        std::path::PathBuf::from(home)
            .join("Library/LaunchAgents")
            .join(format!("{LABEL}.plist"))
    })
}

#[cfg(target_os = "macos")]
fn xml_escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

#[cfg(target_os = "macos")]
pub fn is_enabled() -> bool {
    agent_path().map(|p| p.exists()).unwrap_or(false)
}

#[cfg(target_os = "macos")]
pub fn set_enabled(enabled: bool) -> Result<(), String> {
    let path = agent_path().ok_or("No home folder")?;
    if !enabled {
        if path.exists() {
            std::fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let plist = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>{}</string><string>{HIDDEN_ARG}</string></array>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
"#,
        xml_escape(&exe.to_string_lossy())
    );
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, plist).map_err(|e| e.to_string())
}

#[cfg(target_os = "windows")]
const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
#[cfg(target_os = "windows")]
const VALUE: &str = "0xio Desktop";

#[cfg(target_os = "windows")]
fn reg(args: &[&str]) -> std::io::Result<std::process::Output> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::process::Command::new("reg").args(args).creation_flags(CREATE_NO_WINDOW).output()
}

#[cfg(target_os = "windows")]
pub fn is_enabled() -> bool {
    reg(&["query", RUN_KEY, "/v", VALUE]).map(|o| o.status.success()).unwrap_or(false)
}

#[cfg(target_os = "windows")]
pub fn set_enabled(enabled: bool) -> Result<(), String> {
    let out = if enabled {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let data = format!("\"{}\" {HIDDEN_ARG}", exe.to_string_lossy());
        reg(&["add", RUN_KEY, "/v", VALUE, "/t", "REG_SZ", "/d", &data, "/f"])
    } else {
        if !is_enabled() {
            return Ok(());
        }
        reg(&["delete", RUN_KEY, "/v", VALUE, "/f"])
    }
    .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn is_enabled() -> bool {
    false
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn set_enabled(_enabled: bool) -> Result<(), String> {
    Err("Open at login is not supported on this system".into())
}

pub fn launched_hidden() -> bool {
    std::env::args().any(|a| a == HIDDEN_ARG)
}
