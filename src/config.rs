use std::{fmt::Formatter, path::PathBuf, sync::LazyLock};

use base64::Engine;
use hmac::{
    digest::{array::Array, common::KeySizeUser, Key},
    Hmac,
};
use serde::{
    de::{Error, Visitor},
    Deserialize, Deserializer,
};
use sha2::Sha224;

type Secret = Key<Hmac<Sha224>>;

#[derive(Deserialize)]
pub struct Config {
    pub bind: String,
    pub file_dir: PathBuf,
    /// Public origin without a trailing slash, e.g. `https://i.example.com`.
    pub domain: String,
    pub authorization: String,
    #[serde(deserialize_with = "from_base64")]
    pub secret: Secret,
    /// Largest accepted upload in MiB.
    #[serde(default = "default_max_upload_mib")]
    pub max_upload_mib: u64,
    /// Where scoped upload keys are kept (hashed). Created on first use.
    #[serde(default = "default_keys_file")]
    pub keys_file: PathBuf,
}

fn default_keys_file() -> PathBuf {
    PathBuf::from("keys.json")
}

fn default_max_upload_mib() -> u64 {
    256
}

impl Config {
    pub fn max_upload_bytes(&self) -> u64 {
        self.max_upload_mib.saturating_mul(1024 * 1024)
    }

    pub fn domain(&self) -> &str {
        self.domain.trim_end_matches('/')
    }
}

pub static CONFIG: LazyLock<Config> = LazyLock::new(|| {
    let text = std::fs::read_to_string("config.toml")
        .expect("A config.toml must be in the working directory");
    toml::from_str(&text).unwrap_or_else(|e| panic!("The config.toml is invalid: {e}"))
});

fn from_base64<'de, D>(de: D) -> Result<Secret, D::Error>
where
    D: Deserializer<'de>,
{
    struct Base64Visitor;
    impl Visitor<'_> for Base64Visitor {
        type Value = Secret;

        fn expecting(&self, f: &mut Formatter) -> std::fmt::Result {
            write!(f, "a base64 string of 28 bytes")
        }

        fn visit_str<E>(self, v: &str) -> Result<Self::Value, E>
        where
            E: Error,
        {
            let mut arr = Array::<u8, <Hmac<Sha224> as KeySizeUser>::KeySize>::default();
            let len = base64::engine::general_purpose::STANDARD
                .decode_slice(v, &mut arr[..])
                .map_err(E::custom)?;
            if len < 28 {
                return Err(E::custom(format!(
                    "secret is {len} bytes, it needs at least 28 (use `openssl rand -base64 28`)"
                )));
            }
            Ok(arr)
        }
    }
    de.deserialize_str(Base64Visitor)
}
