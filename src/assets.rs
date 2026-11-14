//! Versioned static files.
//!
//! Pages load everything from `/static/v-<hash>/…`, where the hash covers every file in
//! `static/`. An update changes the path, so a browser or CDN can't pair a new page with an old
//! cached script (a module importing an export the cached file lacks stops the whole page). The
//! files inside a version never change, so they're cached for a year. Scripts and styles use
//! relative paths, so they stay inside the version they were loaded from.

use std::{
    fs,
    path::{Path, PathBuf},
    sync::LazyLock,
};

use sha2::{Digest, Sha256};

static BASE: LazyLock<String> =
    LazyLock::new(|| format!("/static/v-{}", version_of(Path::new("static"))));

/// Where this build's static files are served, e.g. `/static/v-1a2b3c4d`. No trailing slash.
pub fn base() -> &'static str {
    &BASE
}

/// Whether a `/static/{ver}/` segment names the files being served now.
pub fn is_current(segment: &str) -> bool {
    BASE.rsplit('/').next() == Some(segment)
}

/// A short hash over every file's path and contents, in a stable order.
fn version_of(dir: &Path) -> String {
    let mut files = Vec::new();
    collect(dir, &mut files);
    files.sort();
    let mut hasher = Sha256::new();
    for file in files {
        let rel = file.strip_prefix(dir).unwrap_or(&file);
        hasher.update(rel.to_string_lossy().replace('\\', "/").as_bytes());
        hasher.update([0]);
        // An unreadable file still changes the hash through its name; serving it will fail anyway.
        hasher.update(fs::read(&file).unwrap_or_default());
        hasher.update([0]);
    }
    hasher.finalize()[..4]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn collect(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect(&path, out);
        } else {
            out.push(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_follows_contents() {
        let dir = std::env::temp_dir().join(format!("uploader-assets-{}", std::process::id()));
        fs::create_dir_all(dir.join("js")).unwrap();
        fs::write(dir.join("js/a.js"), "one").unwrap();
        let first = version_of(&dir);
        assert_eq!(first.len(), 8);
        assert_eq!(version_of(&dir), first);
        fs::write(dir.join("js/a.js"), "two").unwrap();
        assert_ne!(version_of(&dir), first);
        fs::remove_dir_all(dir).ok();
    }
}
