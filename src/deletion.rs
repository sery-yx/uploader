use std::io;

use actix_web::{delete, get, web, HttpResponse};
use base64::{
    engine::{
        general_purpose::{GeneralPurpose, GeneralPurposeConfig},
        DecodePaddingMode,
    },
    Engine,
};
use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha224;

use crate::{
    config::CONFIG,
    media,
    templates::{self, DeleteState},
};

type HmacSha224 = Hmac<Sha224>;

/// A SHA-224 MAC is 28 bytes, which is 38 characters of unpadded base64.
const KEY_LEN: usize = 38;

const DELETION_KEY_ENGINE: GeneralPurpose = GeneralPurpose::new(
    &base64::alphabet::URL_SAFE,
    GeneralPurposeConfig::new()
        .with_encode_padding(false)
        .with_decode_padding_mode(DecodePaddingMode::Indifferent),
);

type Secret = hmac::digest::Key<HmacSha224>;

fn mac_for(secret: &Secret, filename: &str) -> [u8; 28] {
    let mut mac = HmacSha224::new(secret);
    mac.update(filename.as_bytes());
    mac.finalize().into_bytes().into()
}

pub fn make_key(filename: &str) -> String {
    make_key_with(&CONFIG.secret, filename)
}

fn check_key(filename: &str, key: &str) -> bool {
    check_key_with(&CONFIG.secret, filename, key)
}

fn make_key_with(secret: &Secret, filename: &str) -> String {
    let mut buf = String::with_capacity(KEY_LEN);
    DELETION_KEY_ENGINE.encode_string(mac_for(secret, filename), &mut buf);
    buf
}

fn check_key_with(secret: &Secret, filename: &str, key: &str) -> bool {
    if key.len() != KEY_LEN {
        return false;
    }
    let mut decoded = [0u8; 32];
    match DELETION_KEY_ENGINE.decode_slice(key, &mut decoded) {
        Ok(28) => constant_time_eq::constant_time_eq(&mac_for(secret, filename), &decoded[..28]),
        _ => false,
    }
}

#[derive(Debug, thiserror::Error, actix_web_error::Json)]
pub enum DeletionError {
    #[error("This deletion link isn't valid")]
    #[status(401)]
    InvalidKey,
    #[error("This file doesn't exist, it may already be deleted")]
    #[status(404)]
    NotFound,
    #[error("Couldn't delete the file")]
    #[status(500)]
    Io(io::Error),
}

/// Whether this name and key are a genuine deletion link. Both the page and the delete
/// request go through here.
fn verified(filename: &str, key: &str) -> bool {
    media::is_valid_stored_name(filename) && check_key(filename, key)
}

#[delete("/d/{filename}/{key}")]
pub async fn delete_file(path: web::Path<(String, String)>) -> Result<HttpResponse, DeletionError> {
    let (filename, key) = path.into_inner();
    if !verified(&filename, &key) {
        return Err(DeletionError::InvalidKey);
    }
    match tokio::fs::remove_file(CONFIG.file_dir.join(&filename)).await {
        Ok(()) => Ok(HttpResponse::NoContent().finish()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Err(DeletionError::NotFound),
        Err(e) => {
            tracing::warn!(error = %e, "Couldn't delete a file");
            Err(DeletionError::Io(e))
        }
    }
}

#[get("/d/{filename}/{key}")]
pub async fn delete_page(path: web::Path<(String, String)>) -> HttpResponse {
    let (filename, key) = path.into_inner();
    let state = if !verified(&filename, &key) {
        DeleteState::Invalid
    } else if tokio::fs::metadata(CONFIG.file_dir.join(&filename))
        .await
        .is_ok_and(|m| m.is_file())
    {
        DeleteState::Ready
    } else {
        DeleteState::Gone
    };
    templates::delete_page(&filename, state)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_round_trip() {
        let mut secret = Secret::default();
        secret[..28].copy_from_slice(&[7u8; 28]);
        let other = Secret::default();

        let key = make_key_with(&secret, "abc.png");
        assert_eq!(key.len(), KEY_LEN);
        assert!(check_key_with(&secret, "abc.png", &key));
        assert!(!check_key_with(&other, "abc.png", &key));
        assert!(!check_key_with(&secret, "abd.png", &key));
        assert!(!check_key_with(&secret, "abc.png", &key[1..]));
        assert!(!check_key_with(&secret, "abc.png", &"A".repeat(KEY_LEN)));
    }
}
