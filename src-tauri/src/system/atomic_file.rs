use std::fs::OpenOptions;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

fn temp_path(path: &Path) -> io::Result<PathBuf> {
    let mut name = path
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "no file name"))?
        .to_os_string();
    name.push(".tmp");
    Ok(path.with_file_name(name))
}

/// A crash leaves the old file or the new one, never a partial one. Readable by this user only.
pub fn write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let dir = match path.parent() {
        Some(d) if !d.as_os_str().is_empty() => d,
        _ => Path::new("."),
    };
    std::fs::create_dir_all(dir)?;
    let tmp = temp_path(path)?;
    let _ = std::fs::remove_file(&tmp);
    let result = (|| {
        let mut opts = OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut file = opts.open(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&tmp, path)?;
        sync_dir(dir)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

#[cfg(unix)]
fn sync_dir(dir: &Path) -> io::Result<()> {
    std::fs::File::open(dir)?.sync_all()
}

#[cfg(not(unix))]
fn sync_dir(_dir: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
pub(crate) fn scratch_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("oxio-{}-{}", tag, crate::system::uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_the_file_and_leaves_no_temp_behind() {
        let dir = scratch_dir("atomic");
        let path = dir.join("state.json");
        write(&path, b"first").unwrap();
        write(&path, b"second").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"second");
        assert!(!temp_path(&path).unwrap().exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_stale_temp_from_a_crash_does_not_block_the_next_write() {
        let dir = scratch_dir("atomic");
        let path = dir.join("state.json");
        std::fs::write(temp_path(&path).unwrap(), b"half").unwrap();
        write(&path, b"whole").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"whole");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn the_file_is_readable_by_this_user_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch_dir("atomic");
        let path = dir.join("state.json");
        write(&path, b"x").unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
