//! What kind of file something is, and how we talk about it.
//!
//! The kind is derived from the stored file's extension only, so serving a file never needs
//! a database or a second read of its bytes.

use std::time::SystemTime;

/// The viewer a file gets when someone opens its link in a browser.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// Pictures, including GIF, animated WebP and APNG.
    Image,
    Video,
    Audio,
    Text,
    /// Anything we can't preview; the viewer offers a download.
    Other,
}

impl Kind {
    pub fn from_mime(mime: &mime::Mime) -> Self {
        match mime.type_() {
            mime::IMAGE => Kind::Image,
            mime::VIDEO => Kind::Video,
            mime::AUDIO => Kind::Audio,
            mime::TEXT => Kind::Text,
            mime::APPLICATION if is_text_application(mime.subtype().as_str()) => Kind::Text,
            _ => Kind::Other,
        }
    }

    pub fn from_extension(ext: &str) -> Self {
        Self::from_mime(&mime_for_extension(ext))
    }

    /// Stable name used in templates, CSS hooks and the upload response.
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Image => "image",
            Kind::Video => "video",
            Kind::Audio => "audio",
            Kind::Text => "text",
            Kind::Other => "file",
        }
    }
}

/// Application types that are really readable text.
fn is_text_application(subtype: &str) -> bool {
    matches!(
        subtype,
        "json" | "xml" | "javascript" | "x-javascript" | "toml" | "x-sh" | "sql" | "x-yaml"
    )
}

/// `mime_guess` misses a few types people upload a lot; fill those in first.
pub fn mime_for_extension(ext: &str) -> mime::Mime {
    let ext = ext.to_ascii_lowercase();
    let known = match ext.as_str() {
        "mkv" => Some("video/x-matroska"),
        "mov" => Some("video/quicktime"),
        "m4v" => Some("video/mp4"),
        "opus" => Some("audio/ogg"),
        "flac" => Some("audio/flac"),
        "avif" => Some("image/avif"),
        "apng" => Some("image/apng"),
        "jxl" => Some("image/jxl"),
        // Never hand out uploads as script: a page on our origin could load them with
        // `script-src 'self'`. Plain text still gets the text viewer.
        "js" | "mjs" | "cjs" => Some("text/plain"),
        "wasm" => Some("application/octet-stream"),
        "yaml" | "yml" => Some("application/x-yaml"),
        "toml" => Some("application/toml"),
        "log" | "md" | "ini" | "cfg" | "conf" | "env" | "csv" | "tsv" => Some("text/plain"),
        "rs" | "py" | "go" | "c" | "h" | "cpp" | "hpp" | "cs" | "java" | "kt" | "ts" | "tsx"
        | "jsx" | "svelte" | "vue" | "lua" | "rb" | "php" | "ps1" | "bat" | "zig" => {
            Some("text/plain")
        }
        _ => None,
    };
    match known {
        Some(m) => m.parse().expect("static mime types are valid"),
        None => mime_guess::from_ext(&ext).first_or_octet_stream(),
    }
}

/// Keeps a user-supplied extension only if it is short, plain ASCII and not executable in a
/// browser. Returns it lowercased.
pub fn sanitize_extension(ext: &str) -> Option<String> {
    let ok = !ext.is_empty() && ext.len() <= 10 && ext.bytes().all(|b| b.is_ascii_alphanumeric());
    if !ok {
        return None;
    }
    let ext = ext.to_ascii_lowercase();
    // These would be rendered as active documents if someone opened the raw file. Raw files are
    // also sandboxed by CSP, but there's no reason to store them under these names at all.
    match ext.as_str() {
        "html" | "htm" | "xhtml" | "xht" | "mht" | "mhtml" | "shtml" => Some("txt".to_owned()),
        _ => Some(ext),
    }
}

/// The extension of a user-supplied file name, if it has a usable one.
///
/// The name may arrive percent-encoded (the browser upload does that so non-Latin names survive
/// an HTTP header); the extension itself is plain ASCII either way.
pub fn extension_of(filename: &str) -> Option<String> {
    let base = filename.rsplit(['/', '\\']).next().unwrap_or(filename);
    let (stem, ext) = base.rsplit_once('.')?;
    if stem.is_empty() {
        return None; // ".bashrc" has no extension
    }
    sanitize_extension(ext)
}

/// A stored file's name is one path segment we generated: `[A-Za-z0-9_-]+.[a-z0-9]+`.
/// Anything else is refused before it touches the file system.
pub fn is_valid_stored_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && !name.starts_with('.')
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
        && !name.contains("..")
}

pub fn is_svg(ext: &str) -> bool {
    ext.eq_ignore_ascii_case("svg")
}

pub fn extension_of_stored(name: &str) -> &str {
    name.rsplit_once('.').map_or("", |(_, e)| e)
}

/// cyex size format: `999 B`, `1,5 KB`, `12,3 MB`, `120 MB`.
pub fn format_size(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    if bytes < 1024 {
        return format!("{} B", group_thousands(bytes));
    }
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    // Round down so we never claim more than the file has.
    let text = if value >= 100.0 {
        format!("{}", value.floor() as u64)
    } else {
        let tenths = (value * 10.0).floor() / 10.0;
        let s = format!("{tenths:.1}");
        s.strip_suffix(".0").map(str::to_owned).unwrap_or(s)
    };
    format!("{} {}", text.replace('.', ","), UNITS[unit])
}

/// cyex thousands: `40.000`.
pub fn group_thousands(n: u64) -> String {
    let digits = n.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push('.');
        }
        out.push(c);
    }
    out
}

/// cyex date format, UTC: `2026/11/13`.
pub fn format_date(time: SystemTime) -> String {
    let stamp = humantime::format_rfc3339_seconds(time).to_string();
    stamp[..10].replace('-', "/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_from_extension() {
        assert_eq!(Kind::from_extension("png"), Kind::Image);
        assert_eq!(Kind::from_extension("GIF"), Kind::Image);
        assert_eq!(Kind::from_extension("webp"), Kind::Image);
        assert_eq!(Kind::from_extension("mp4"), Kind::Video);
        assert_eq!(Kind::from_extension("webm"), Kind::Video);
        assert_eq!(Kind::from_extension("mkv"), Kind::Video);
        assert_eq!(Kind::from_extension("mov"), Kind::Video);
        assert_eq!(Kind::from_extension("mp3"), Kind::Audio);
        assert_eq!(Kind::from_extension("opus"), Kind::Audio);
        assert_eq!(Kind::from_extension("txt"), Kind::Text);
        assert_eq!(Kind::from_extension("json"), Kind::Text);
        assert_eq!(Kind::from_extension("rs"), Kind::Text);
        assert_eq!(Kind::from_extension("js"), Kind::Text);
        assert_eq!(mime_for_extension("js").essence_str(), "text/plain");
        assert_eq!(mime_for_extension("mjs").essence_str(), "text/plain");
        assert_eq!(Kind::from_extension("zip"), Kind::Other);
        assert_eq!(Kind::from_extension("bin"), Kind::Other);
    }

    #[test]
    fn extensions_are_sanitized() {
        assert_eq!(extension_of("clip.MP4").as_deref(), Some("mp4"));
        assert_eq!(extension_of("a.b.tar.gz").as_deref(), Some("gz"));
        assert_eq!(
            extension_of("%E6%97%A5%E6%9C%AC.png").as_deref(),
            Some("png")
        );
        assert_eq!(extension_of("../../evil.png").as_deref(), Some("png"));
        assert_eq!(extension_of("C:\\x\\y.jpg").as_deref(), Some("jpg"));
        assert_eq!(extension_of("page.html").as_deref(), Some("txt"));
        assert_eq!(extension_of(".bashrc"), None);
        assert_eq!(extension_of("noext"), None);
        assert_eq!(extension_of("x.ex%2Fe"), None);
        assert_eq!(extension_of("x.waytoolongextension"), None);
    }

    #[test]
    fn stored_names() {
        assert!(is_valid_stored_name("aB3-_x9.png"));
        assert!(!is_valid_stored_name(".hidden"));
        assert!(!is_valid_stored_name("a..png"));
        assert!(!is_valid_stored_name("a/b.png"));
        assert!(!is_valid_stored_name("a\\b.png"));
        assert!(!is_valid_stored_name("a b.png"));
        assert!(!is_valid_stored_name(""));
    }

    #[test]
    fn sizes_use_cyex_format() {
        assert_eq!(format_size(0), "0 B");
        assert_eq!(format_size(1023), "1.023 B");
        assert_eq!(group_thousands(1_000_000), "1.000.000");
        assert_eq!(group_thousands(999), "999");
        assert_eq!(format_size(1024), "1 KB");
        assert_eq!(format_size(1536), "1,5 KB");
        assert_eq!(format_size(1024 * 1024 * 12 + 1024 * 400), "12,3 MB");
        assert_eq!(format_size(1024 * 1024 * 150), "150 MB");
    }

    #[test]
    fn dates_use_cyex_format() {
        let t = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_794_571_200);
        assert_eq!(format_date(t), "2026/11/13");
    }
}
