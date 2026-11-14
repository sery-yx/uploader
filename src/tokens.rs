//! Upload keys the admin hands out, each limited to some kinds of files.
//!
//! Keys are looked up by their SHA-256 hash. The key itself is kept too, so the admin can look it
//! up again later; the file is as sensitive as `config.toml` and is written owner-only on Unix.
//! Keys made before that was kept have only the hash and can't be shown until they're reset.
//! The store is a small JSON file, kept in memory and rewritten on every change.

use std::{
    collections::BTreeSet,
    io::{self, Write},
    path::PathBuf,
    sync::{LazyLock, RwLock, RwLockReadGuard, RwLockWriteGuard},
    time::{SystemTime, UNIX_EPOCH},
};

use base64::Engine;
use rand::Rng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    config::CONFIG,
    media::{self, Kind},
};

/// What a key may upload. GIFs are separate from other pictures so a key can be GIF-only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Perm {
    Image,
    Gif,
    Video,
    Audio,
    Text,
    File,
}

impl Perm {
    pub const ALL: [Perm; 6] = [
        Perm::Image,
        Perm::Gif,
        Perm::Video,
        Perm::Audio,
        Perm::Text,
        Perm::File,
    ];

    /// The permission a stored extension needs.
    pub fn for_extension(ext: &str) -> Perm {
        if ext.eq_ignore_ascii_case("gif") {
            return Perm::Gif;
        }
        match Kind::from_extension(ext) {
            Kind::Image => Perm::Image,
            Kind::Video => Perm::Video,
            Kind::Audio => Perm::Audio,
            Kind::Text => Perm::Text,
            Kind::Other => Perm::File,
        }
    }

    /// Name of one such file, for the viewer's chip and the picked-file row: "Picture", "GIF".
    pub fn singular(self) -> &'static str {
        match self {
            Perm::Image => "Picture",
            Perm::Gif => "GIF",
            Perm::Video => "Video",
            Perm::Audio => "Audio",
            Perm::Text => "Text",
            Perm::File => "File",
        }
    }

    /// Checkbox label on the Keys page: "Pictures", "Other files".
    pub fn label(self) -> &'static str {
        match self {
            Perm::Image => "Pictures",
            Perm::Gif => "GIFs",
            Perm::Video => "Video",
            Perm::Audio => "Audio",
            Perm::Text => "Text",
            Perm::File => "Other files",
        }
    }

    /// Plural noun for messages: "This key can only upload pictures and GIFs."
    pub fn plural(self) -> &'static str {
        match self {
            Perm::Image => "pictures",
            Perm::Gif => "GIFs",
            Perm::Video => "videos",
            Perm::Audio => "audio",
            Perm::Text => "text",
            Perm::File => "other files",
        }
    }
}

/// The permission table the pages use, so the browser classifies files exactly like the server:
/// every permission with its words, and the permission of each common extension.
pub fn client_table() -> serde_json::Value {
    let perms: Vec<_> = Perm::ALL
        .iter()
        .map(|p| {
            serde_json::json!({
                "id": p, "label": p.label(), "one": p.singular(), "noun": p.plural(),
            })
        })
        .collect();
    let exts: serde_json::Map<_, _> = media::COMMON_EXTENSIONS
        .iter()
        .map(|ext| {
            (
                (*ext).to_owned(),
                serde_json::json!(Perm::for_extension(ext)),
            )
        })
        .collect();
    serde_json::json!({ "perms": perms, "exts": exts })
}

/// "pictures", "pictures and GIFs", "pictures, GIFs and videos"
pub fn describe(perms: &BTreeSet<Perm>) -> String {
    let words: Vec<_> = perms.iter().map(|p| p.plural()).collect();
    match words.as_slice() {
        [] => "nothing".to_owned(),
        [one] => (*one).to_owned(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct KeyEntry {
    pub id: String,
    pub name: String,
    /// Hex SHA-256 of the key.
    hash: String,
    /// The key itself, so the admin can see it again. Missing on keys made before it was kept.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    secret: Option<String>,
    pub perms: BTreeSet<Perm>,
    /// Unix seconds.
    pub created: u64,
    /// Unix seconds of the last reset, if any.
    #[serde(default)]
    pub reset: Option<u64>,
}

// By hand, so the key itself never ends up in a log line.
impl std::fmt::Debug for KeyEntry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("KeyEntry")
            .field("id", &self.id)
            .field("name", &self.name)
            .field("perms", &self.perms)
            .field("created", &self.created)
            .field("reset", &self.reset)
            .finish_non_exhaustive()
    }
}

/// What the admin page sees: everything but the hash.
#[derive(Debug, Serialize)]
pub struct KeyInfo {
    pub id: String,
    pub name: String,
    pub perms: BTreeSet<Perm>,
    pub created: u64,
    pub reset: Option<u64>,
    /// Whether the admin can look the key up again (keys from before that was possible can't).
    pub viewable: bool,
}

impl From<&KeyEntry> for KeyInfo {
    fn from(e: &KeyEntry) -> Self {
        KeyInfo {
            id: e.id.clone(),
            name: e.name.clone(),
            perms: e.perms.clone(),
            created: e.created,
            reset: e.reset,
            viewable: e.secret.is_some(),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("No key has that id")]
    NotFound,
    #[error("{0}")]
    Invalid(&'static str),
    #[error("Couldn't save the key list: {0}")]
    Io(#[from] io::Error),
}

pub struct KeyStore {
    path: PathBuf,
    entries: Vec<KeyEntry>,
}

static KEYS: LazyLock<RwLock<KeyStore>> =
    LazyLock::new(|| RwLock::new(KeyStore::load(CONFIG.keys_file.clone())));

/// The key list for reading. A panic while holding the lock can't leave the list half-changed
/// (changes are rolled back on failure), so a poisoned lock is still safe to use.
pub fn keys() -> RwLockReadGuard<'static, KeyStore> {
    KEYS.read().unwrap_or_else(|e| e.into_inner())
}

/// The key list for changing, with the same poison recovery as [`keys`].
pub fn keys_mut() -> RwLockWriteGuard<'static, KeyStore> {
    KEYS.write().unwrap_or_else(|e| e.into_inner())
}

/// A fresh key: `upl_` and 32 random bytes in URL-safe base64.
fn new_secret() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    let mut out = String::from("upl_");
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode_string(bytes, &mut out);
    out
}

fn new_id() -> String {
    let mut bytes = [0u8; 5];
    rand::rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn hash(secret: &str) -> String {
    Sha256::digest(secret.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

fn clean_name(name: &str) -> Result<String, StoreError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(StoreError::Invalid("Give the key a name"));
    }
    if name.chars().count() > 60 {
        return Err(StoreError::Invalid("Keep the name to 60 characters"));
    }
    if name.chars().any(char::is_control) {
        return Err(StoreError::Invalid(
            "The name can't contain control characters",
        ));
    }
    Ok(name.to_owned())
}

fn check_perms(perms: &BTreeSet<Perm>) -> Result<(), StoreError> {
    if perms.is_empty() {
        Err(StoreError::Invalid("Pick at least one kind of file"))
    } else {
        Ok(())
    }
}

impl KeyStore {
    fn load(path: PathBuf) -> Self {
        let entries = match std::fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str(&text)
                .unwrap_or_else(|e| panic!("{} is not a valid key list: {e}", path.display())),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Vec::new(),
            Err(e) => panic!("Couldn't read {}: {e}", path.display()),
        };
        KeyStore { path, entries }
    }

    /// Writes the list to a temporary file and renames it over the old one, so a crash never
    /// leaves half a file.
    fn save(&self) -> io::Result<()> {
        let json = serde_json::to_string_pretty(&self.entries).map_err(io::Error::other)?;
        let tmp = self.path.with_extension("json.tmp");
        // A fresh file every time, so it gets the owner-only mode below even if a leftover
        // temporary file from an older version was readable by others.
        match std::fs::remove_file(&tmp) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
            _ => {}
        }
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let mut file = options.open(&tmp)?;
        file.write_all(json.as_bytes())?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&tmp, &self.path)
    }

    /// Applies `change`, saves, and rolls back if saving fails.
    fn commit<T>(
        &mut self,
        change: impl FnOnce(&mut Vec<KeyEntry>) -> Result<T, StoreError>,
    ) -> Result<T, StoreError> {
        let before = self.entries.clone();
        let out = change(&mut self.entries)?;
        if let Err(e) = self.save() {
            self.entries = before;
            return Err(e.into());
        }
        Ok(out)
    }

    pub fn list(&self) -> Vec<KeyInfo> {
        self.entries.iter().map(KeyInfo::from).collect()
    }

    /// The key itself, for the admin. `None` for a key made before keys were kept.
    pub fn secret(&self, id: &str) -> Result<(Option<String>, KeyInfo), StoreError> {
        let e = self
            .entries
            .iter()
            .find(|e| e.id == id)
            .ok_or(StoreError::NotFound)?;
        Ok((e.secret.clone(), KeyInfo::from(e)))
    }

    /// The permissions of a key, if it exists.
    pub fn resolve(&self, secret: &str) -> Option<(String, BTreeSet<Perm>)> {
        let h = hash(secret);
        self.entries
            .iter()
            .find(|e| e.hash == h)
            .map(|e| (e.name.clone(), e.perms.clone()))
    }

    pub fn create(
        &mut self,
        name: &str,
        perms: BTreeSet<Perm>,
    ) -> Result<(String, KeyInfo), StoreError> {
        let name = clean_name(name)?;
        check_perms(&perms)?;
        let secret = new_secret();
        let entry = KeyEntry {
            id: new_id(),
            name,
            hash: hash(&secret),
            secret: Some(secret.clone()),
            perms,
            created: now(),
            reset: None,
        };
        let info = KeyInfo::from(&entry);
        self.commit(|entries| {
            entries.push(entry);
            Ok(())
        })?;
        Ok((secret, info))
    }

    pub fn update(
        &mut self,
        id: &str,
        name: &str,
        perms: BTreeSet<Perm>,
    ) -> Result<KeyInfo, StoreError> {
        let name = clean_name(name)?;
        check_perms(&perms)?;
        self.commit(|entries| {
            let e = entries
                .iter_mut()
                .find(|e| e.id == id)
                .ok_or(StoreError::NotFound)?;
            e.name = name;
            e.perms = perms;
            Ok(KeyInfo::from(&*e))
        })
    }

    /// A new value for an existing key; the old one stops working at once.
    pub fn reset(&mut self, id: &str) -> Result<(String, KeyInfo), StoreError> {
        let secret = new_secret();
        let h = hash(&secret);
        let kept = secret.clone();
        let info = self.commit(|entries| {
            let e = entries
                .iter_mut()
                .find(|e| e.id == id)
                .ok_or(StoreError::NotFound)?;
            e.hash = h;
            e.secret = Some(kept);
            e.reset = Some(now());
            Ok(KeyInfo::from(&*e))
        })?;
        Ok((secret, info))
    }

    pub fn delete(&mut self, id: &str) -> Result<(), StoreError> {
        self.commit(|entries| {
            let len = entries.len();
            entries.retain(|e| e.id != id);
            if entries.len() == len {
                Err(StoreError::NotFound)
            } else {
                Ok(())
            }
        })
    }
}

/// Whether a scoped key may store this upload. Both the name's type and what the bytes look
/// like must be allowed, so a video renamed to `.gif` doesn't get past a GIF-only key.
pub fn upload_allowed(perms: &BTreeSet<Perm>, extension: &str, sniffed: &str) -> bool {
    let claimed = Perm::for_extension(extension);
    if !perms.contains(&claimed) {
        return false;
    }
    let actual = Perm::for_extension(sniffed);
    if actual == claimed || perms.contains(&actual) {
        return true;
    }
    // SVG is XML, which sniffs as text.
    claimed == Perm::Image && media::is_svg(extension) && actual == Perm::Text
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(p: &[Perm]) -> BTreeSet<Perm> {
        p.iter().copied().collect()
    }

    #[test]
    fn perms_follow_the_extension() {
        assert_eq!(Perm::for_extension("gif"), Perm::Gif);
        assert_eq!(Perm::for_extension("GIF"), Perm::Gif);
        assert_eq!(Perm::for_extension("png"), Perm::Image);
        assert_eq!(Perm::for_extension("webm"), Perm::Video);
        assert_eq!(Perm::for_extension("mp3"), Perm::Audio);
        assert_eq!(Perm::for_extension("txt"), Perm::Text);
        assert_eq!(Perm::for_extension("zip"), Perm::File);
        assert_eq!(Perm::for_extension("bin"), Perm::File);
    }

    #[test]
    fn scoped_uploads() {
        let gifs = set(&[Perm::Gif]);
        assert!(upload_allowed(&gifs, "gif", "gif"));
        assert!(!upload_allowed(&gifs, "png", "png"));
        assert!(!upload_allowed(&gifs, "mp4", "mp4"));
        // a video renamed to .gif
        assert!(!upload_allowed(&gifs, "gif", "mp4"));

        let pictures = set(&[Perm::Image]);
        assert!(upload_allowed(&pictures, "jpg", "jpg"));
        assert!(upload_allowed(&pictures, "jpeg", "jpg"));
        assert!(!upload_allowed(&pictures, "gif", "gif"));
        assert!(upload_allowed(&pictures, "svg", "xml"));
        assert!(upload_allowed(&pictures, "svg", "txt"));
        assert!(!upload_allowed(&pictures, "png", "txt"));

        let video = set(&[Perm::Video]);
        assert!(upload_allowed(&video, "mp4", "mp4"));
        assert!(upload_allowed(&video, "mov", "mov"));
        assert!(!upload_allowed(&video, "txt", "txt"));
    }

    #[test]
    fn client_table_matches_the_server() {
        let table = client_table();
        let exts = table["exts"].as_object().unwrap();
        // Formats browsers leave untyped still get the right permission.
        assert_eq!(exts["mkv"], "video");
        assert_eq!(exts["mov"], "video");
        assert_eq!(exts["flac"], "audio");
        assert_eq!(exts["opus"], "audio");
        assert_eq!(exts["gif"], "gif");
        assert_eq!(exts["png"], "image");
        assert_eq!(exts["svg"], "image");
        assert_eq!(exts["ts"], "text");
        assert_eq!(exts["rs"], "text");
        assert_eq!(exts["html"], "text");
        for ext in media::COMMON_EXTENSIONS {
            assert_eq!(
                exts[*ext],
                serde_json::json!(Perm::for_extension(ext)),
                "{ext}"
            );
        }
        let perms = table["perms"].as_array().unwrap();
        assert_eq!(perms.len(), Perm::ALL.len());
        assert_eq!(perms[1]["id"], "gif");
        assert_eq!(perms[1]["one"], "GIF");
        assert_eq!(perms[5]["label"], "Other files");
    }

    #[test]
    fn old_keys_load_without_a_secret() {
        let old = r#"[{"id":"ab","name":"Old","hash":"00","perms":["gif"],"created":1}]"#;
        let store = KeyStore {
            path: PathBuf::new(),
            entries: serde_json::from_str(old).unwrap(),
        };
        assert!(!store.list()[0].viewable);
        assert_eq!(store.secret("ab").unwrap().0, None);
    }

    #[test]
    fn describes_perms() {
        assert_eq!(describe(&set(&[Perm::Gif])), "GIFs");
        assert_eq!(
            describe(&set(&[Perm::Image, Perm::Gif])),
            "pictures and GIFs"
        );
        assert_eq!(
            describe(&set(&[Perm::Image, Perm::Gif, Perm::Video])),
            "pictures, GIFs and videos"
        );
    }

    #[test]
    fn store_round_trip() {
        let dir = std::env::temp_dir().join(format!("uploader-keys-{}", new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("keys.json");
        let mut store = KeyStore {
            path: path.clone(),
            entries: Vec::new(),
        };

        let (secret, info) = store.create("Phone", set(&[Perm::Image])).unwrap();
        assert!(secret.starts_with("upl_"));
        assert_eq!(store.resolve(&secret).unwrap().1, set(&[Perm::Image]));
        assert!(store.resolve("upl_wrong").is_none());
        // The admin can look the key up again.
        assert_eq!(store.secret(&info.id).unwrap().0.as_deref(), Some(&*secret));
        assert!(info.viewable);

        let (fresh, _) = store.reset(&info.id).unwrap();
        assert!(store.resolve(&secret).is_none());
        assert!(store.resolve(&fresh).is_some());

        store
            .update(&info.id, "Phone 2", set(&[Perm::Gif]))
            .unwrap();
        let reloaded = KeyStore::load(path.clone());
        assert_eq!(reloaded.list()[0].name, "Phone 2");
        assert_eq!(
            reloaded.secret(&info.id).unwrap().0.as_deref(),
            Some(&*fresh)
        );
        assert_eq!(reloaded.resolve(&fresh).unwrap().1, set(&[Perm::Gif]));

        assert!(matches!(
            store.create(" ", set(&[Perm::Gif])),
            Err(StoreError::Invalid(_))
        ));
        assert!(matches!(
            store.create("x", BTreeSet::new()),
            Err(StoreError::Invalid(_))
        ));
        store.delete(&info.id).unwrap();
        assert!(matches!(store.delete(&info.id), Err(StoreError::NotFound)));
        assert!(matches!(store.secret(&info.id), Err(StoreError::NotFound)));
        assert!(store.resolve(&fresh).is_none());
        std::fs::remove_dir_all(dir).ok();
    }
}
