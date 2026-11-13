use std::{
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

use crate::{args::FileMetric, config::CONFIG, media};

/// An unfinished upload is left alone for at least this long, so a slow upload isn't removed
/// from under the server.
const PARTIAL_MIN_AGE: Duration = Duration::from_secs(24 * 60 * 60);

/// The moment before which a file counts as old, or `None` if `max_age` reaches back past
/// the earliest time the system can represent (nothing is that old).
fn cutoff(now: SystemTime, max_age: Duration) -> Option<SystemTime> {
    now.checked_sub(max_age)
}

/// `.NAME.part` is what an upload in progress is written to, see `upload::create_partial`.
fn is_partial_name(name: &str) -> bool {
    name.strip_prefix('.')
        .and_then(|n| n.strip_suffix(".part"))
        .is_some_and(media::is_valid_stored_name)
}

/// The key list shares the upload folder when `keys_file` points into it. It must never be
/// removed, nor the temporary file it's saved through.
fn protected_paths() -> Vec<PathBuf> {
    let keys = &CONFIG.keys_file;
    [keys.clone(), keys.with_extension("json.tmp")]
        .iter()
        .filter_map(|p| std::fs::canonicalize(p).ok())
        .collect()
}

pub fn clean(max_age: Duration, dry_run: bool, metric: FileMetric) -> std::io::Result<()> {
    let now = SystemTime::now();
    let Some(cutoff_time) = cutoff(now, max_age) else {
        println!("Nothing is that old.");
        return Ok(());
    };
    // Partials only go once they're clearly abandoned.
    let partial_cutoff = cutoff(now, max_age.max(PARTIAL_MIN_AGE));
    let protected = protected_paths();
    let mut removed = 0usize;

    for entry in std::fs::read_dir(&CONFIG.file_dir)? {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                eprintln!("Failed to read entry in directory, skipping: {e}");
                continue;
            }
        };
        let file_name = entry.file_name();
        let name = file_name.to_string_lossy();

        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(e) => {
                eprintln!("Failed to read metadata of {name}, skipping: {e}");
                continue;
            }
        };
        if !meta.file_type().is_file() {
            eprintln!("{name} is not a file, skipping");
            continue;
        }

        if is_protected(&entry.path(), &protected) {
            eprintln!("{name} is the key list, skipping");
            continue;
        }
        let limit = if is_partial_name(&name) {
            partial_cutoff
        } else if media::is_valid_stored_name(&name) {
            Some(cutoff_time)
        } else {
            eprintln!("{name} is not an upload, skipping");
            continue;
        };

        let file_time = match metric.extract(&meta) {
            Ok(t) => t,
            Err(e) => {
                eprintln!("Failed to read time of {name}, skipping: {e}");
                continue;
            }
        };
        if limit.is_none_or(|limit| file_time >= limit) {
            continue;
        }
        if dry_run {
            println!("Would remove {name}");
            removed += 1;
        } else if let Err(e) = std::fs::remove_file(entry.path()) {
            eprintln!("Failed to remove {name}: {e}");
        } else {
            removed += 1;
        }
    }

    if dry_run {
        println!("{removed} file(s) would be removed.");
    } else {
        println!("Removed {removed} file(s).");
    }

    Ok(())
}

fn is_protected(path: &Path, protected: &[PathBuf]) -> bool {
    std::fs::canonicalize(path).is_ok_and(|p| protected.contains(&p))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn huge_max_age_does_not_panic() {
        let now = SystemTime::now();
        assert_eq!(cutoff(now, Duration::MAX), None);
        assert_eq!(
            cutoff(now, Duration::from_secs(60)),
            Some(now - Duration::from_secs(60))
        );
    }

    #[test]
    fn recognises_partial_uploads() {
        assert!(is_partial_name(".abc123.png.part"));
        assert!(!is_partial_name("abc123.png"));
        assert!(!is_partial_name(".part"));
        assert!(!is_partial_name(".keys.json"));
    }
}
