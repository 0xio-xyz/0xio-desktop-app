use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

const KEEP: Duration = Duration::from_secs(14 * 24 * 3600);

fn path_for(dir: &Path, date: &str) -> PathBuf {
    dir.join(format!("0xio-{date}.log"))
}

fn is_log(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.starts_with("0xio-") && n.ends_with(".log"))
}

fn untouched_since(path: &Path, now: SystemTime) -> Option<Duration> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    now.duration_since(modified).ok()
}

pub fn prune(dir: &Path, current: &Path, now: SystemTime) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| is_log(path) && path != current)
        .filter(|path| untouched_since(path, now).is_some_and(|quiet| quiet >= KEEP))
        .filter(|path| std::fs::remove_file(path).is_ok())
        .count()
}

fn open(path: &Path) -> io::Result<File> {
    OpenOptions::new().create(true).append(true).open(path)
}

pub struct DailyLog {
    dir: PathBuf,
    date: String,
    file: File,
}

impl DailyLog {
    pub fn start(dir: &Path, date: &str, now: SystemTime) -> io::Result<Self> {
        std::fs::create_dir_all(dir)?;
        let path = path_for(dir, date);
        let file = open(&path)?;
        prune(dir, &path, now);
        Ok(Self { dir: dir.to_path_buf(), date: date.to_string(), file })
    }

    pub fn path(&self) -> PathBuf {
        path_for(&self.dir, &self.date)
    }

    pub fn write(&mut self, bytes: &[u8], date: &str, now: SystemTime) -> Option<PathBuf> {
        let moved = if date == self.date { None } else { self.roll(date, now) };
        let _ = self.file.write_all(bytes);
        let _ = self.file.flush();
        moved
    }

    fn roll(&mut self, date: &str, now: SystemTime) -> Option<PathBuf> {
        let path = path_for(&self.dir, date);
        self.file = open(&path).ok()?;
        self.date = date.to_string();
        prune(&self.dir, &path, now);
        Some(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::system::atomic_file::scratch_dir;

    const DAY: Duration = Duration::from_secs(24 * 3600);

    fn aged(path: &Path, age: Duration, now: SystemTime) {
        std::fs::write(path, b"x").unwrap();
        File::options().write(true).open(path).unwrap().set_modified(now - age).unwrap();
    }

    #[test]
    fn start_removes_logs_untouched_for_two_weeks_and_nothing_else() {
        let dir = scratch_dir("logs");
        let now = SystemTime::now();
        let old = dir.join("0xio-2026-01-01.log");
        let recent = dir.join("0xio-2026-01-20.log");
        let other = dir.join("notes.txt");
        aged(&old, DAY * 15, now);
        aged(&recent, DAY * 13, now);
        aged(&other, DAY * 400, now);
        let log = DailyLog::start(&dir, "2026-02-01", now).unwrap();
        assert!(!old.exists());
        assert!(recent.exists() && other.exists() && log.path().exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_file_in_use_is_kept_however_old_it_is() {
        let dir = scratch_dir("logs");
        let now = SystemTime::now();
        let current = dir.join("0xio-2026-02-01.log");
        aged(&current, DAY * 30, now);
        assert_eq!(prune(&dir, &current, now), 0);
        assert!(current.exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_new_date_moves_writing_to_that_days_file() {
        let dir = scratch_dir("logs");
        let now = SystemTime::now();
        let mut log = DailyLog::start(&dir, "2026-02-01", now).unwrap();
        assert_eq!(log.write(b"one\n", "2026-02-01", now), None);
        let stale = dir.join("0xio-2026-01-01.log");
        aged(&stale, DAY * 20, now);
        let next = dir.join("0xio-2026-02-02.log");
        assert_eq!(log.write(b"two\n", "2026-02-02", now), Some(next.clone()));
        assert_eq!(log.write(b"three\n", "2026-02-02", now), None);
        assert_eq!(std::fs::read(dir.join("0xio-2026-02-01.log")).unwrap(), b"one\n");
        assert_eq!(std::fs::read(&next).unwrap(), b"two\nthree\n");
        assert_eq!(log.path(), next);
        assert!(!stale.exists());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
