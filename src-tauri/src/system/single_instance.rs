//! One copy at a time. The first copy holds a lock file and listens on 127.0.0.1; a later launch
//! hands over (show the window, or nothing for a login launch) and exits. The app takes no URLs,
//! files or deep links, so `--hidden` is the only thing a launch carries.

use std::collections::hash_map::RandomState;
use std::fs::{File, OpenOptions};
use std::hash::{BuildHasher, Hasher};
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use tauri::{AppHandle, Runtime};

const SHOW: &str = "show";
const STAY: &str = "stay";

pub struct Instance {
    _lock: File,
    listener: TcpListener,
    token: String,
}

pub enum Claim {
    First(Instance),
    Running,
    Unavailable,
}

fn data_dir(identifier: &str) -> Option<PathBuf> {
    let home = || std::env::var_os("HOME").map(PathBuf::from);
    #[cfg(target_os = "macos")]
    let base = home().map(|h| h.join("Library/Application Support"));
    #[cfg(target_os = "windows")]
    let base = std::env::var_os("APPDATA").map(PathBuf::from);
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| home().map(|h| h.join(".local/share")));
    Some(base?.join(identifier))
}

/// Release and debug builds keep separate locks so a dev build can run beside the installed app.
fn names() -> (&'static str, &'static str) {
    if cfg!(debug_assertions) {
        ("instance-dev.lock", "instance-dev.port")
    } else {
        ("instance.lock", "instance.port")
    }
}

fn token() -> String {
    let mut h = RandomState::new().build_hasher();
    h.write_u128(
        SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
    );
    h.write_u32(std::process::id());
    format!("{:016x}", h.finish())
}

pub fn claim(identifier: &str) -> Claim {
    let Some(dir) = data_dir(identifier) else {
        return Claim::Unavailable;
    };
    if std::fs::create_dir_all(&dir).is_err() {
        return Claim::Unavailable;
    }
    let (lock_name, port_name) = names();
    let Ok(lock) = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(dir.join(lock_name))
    else {
        return Claim::Unavailable;
    };
    let port_path = dir.join(port_name);
    match lock.try_lock() {
        Ok(()) => {}
        Err(std::fs::TryLockError::WouldBlock) => {
            hand_over(&port_path);
            return Claim::Running;
        }
        Err(_) => return Claim::Unavailable,
    }
    let Ok(listener) = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)) else {
        return Claim::Unavailable;
    };
    let token = token();
    let Ok(addr) = listener.local_addr() else {
        return Claim::Unavailable;
    };
    if crate::system::atomic_file::write(&port_path, format!("{} {}", addr.port(), token).as_bytes())
        .is_err()
    {
        return Claim::Unavailable;
    }
    Claim::First(Instance {
        _lock: lock,
        listener,
        token,
    })
}

/// The first copy may still be writing its port file, so this tries for about a second.
fn hand_over(port_path: &Path) {
    let message = if crate::system::autostart::launched_hidden() {
        STAY
    } else {
        SHOW
    };
    for _ in 0..20 {
        if let Some((port, token)) = std::fs::read_to_string(port_path)
            .ok()
            .and_then(|s| {
                s.split_once(' ')
                    .map(|(p, t)| (p.parse::<u16>().ok(), t.trim().to_string()))
            })
            .and_then(|(p, t)| Some((p?, t)))
        {
            let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
            if let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(500)) {
                if stream
                    .write_all(format!("{token} {message}").as_bytes())
                    .is_ok()
                {
                    crate::tlog!("[0xio-desktop] Another copy is running; handed over and exiting");
                    return;
                }
            }
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    crate::tlog!("[0xio-desktop] Another copy is running but did not answer; exiting");
}

impl Instance {
    pub fn listen<R: Runtime>(self, app: AppHandle<R>) {
        std::thread::spawn(move || {
            let Instance {
                _lock,
                listener,
                token,
            } = self;
            for stream in listener.incoming().flatten() {
                let mut stream = stream;
                let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
                let mut buf = [0u8; 64];
                let Ok(n) = stream.read(&mut buf) else {
                    continue;
                };
                let text = String::from_utf8_lossy(&buf[..n]);
                let Some((sent, message)) = text.split_once(' ') else {
                    continue;
                };
                if sent != token || message != SHOW {
                    continue;
                }
                crate::tlog!("[0xio-desktop] A second launch asked for the window");
                let handle = app.clone();
                let _ = app.run_on_main_thread(move || crate::system::tray::show_main(&handle, None));
            }
            drop(_lock);
        });
    }
}
