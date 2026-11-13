//! Who is calling: the admin (the `authorization` value from config.toml) or a scoped key.

use std::{
    collections::BTreeSet,
    future::{ready, Ready},
};

use actix_web::{dev::Payload, FromRequest, HttpRequest};
use constant_time_eq::constant_time_eq;

use crate::{
    config::CONFIG,
    tokens::{Perm, KEYS},
};

#[derive(Debug, thiserror::Error, actix_web_error::Json)]
pub enum AuthError {
    #[error("Send your upload key in the Authorization header")]
    #[status(401)]
    NoHeader,
    #[error("That upload key isn't valid")]
    #[status(401)]
    BadAuth,
    #[error("Only the admin key can manage keys")]
    #[status(403)]
    NotAdmin,
}

pub enum Caller {
    Admin,
    Scoped { name: String, perms: BTreeSet<Perm> },
}

impl Caller {
    fn from_header(value: &[u8]) -> Result<Self, AuthError> {
        if constant_time_eq(value, CONFIG.authorization.as_bytes()) {
            return Ok(Caller::Admin);
        }
        let value = std::str::from_utf8(value).map_err(|_| AuthError::BadAuth)?;
        // Scoped keys work with or without a "Bearer " prefix.
        let secret = value.strip_prefix("Bearer ").unwrap_or(value).trim();
        if !secret.starts_with("upl_") {
            return Err(AuthError::BadAuth);
        }
        let keys = KEYS.read().unwrap_or_else(|e| e.into_inner());
        keys.resolve(secret)
            .map(|(name, perms)| Caller::Scoped { name, perms })
            .ok_or(AuthError::BadAuth)
    }

    pub fn is_admin(&self) -> bool {
        matches!(self, Caller::Admin)
    }

    pub fn perms(&self) -> BTreeSet<Perm> {
        match self {
            Caller::Admin => Perm::ALL.into_iter().collect(),
            Caller::Scoped { perms, .. } => perms.clone(),
        }
    }
}

impl FromRequest for Caller {
    type Error = AuthError;
    type Future = Ready<Result<Self, Self::Error>>;

    fn from_request(req: &HttpRequest, _: &mut Payload) -> Self::Future {
        ready(match req.headers().get("authorization") {
            Some(h) => Caller::from_header(h.as_bytes()),
            None => Err(AuthError::NoHeader),
        })
    }
}

/// Only the admin gets past this extractor.
pub struct Admin;

impl FromRequest for Admin {
    type Error = AuthError;
    type Future = Ready<Result<Self, Self::Error>>;

    fn from_request(req: &HttpRequest, payload: &mut Payload) -> Self::Future {
        ready(match Caller::from_request(req, payload).into_inner() {
            Ok(Caller::Admin) => Ok(Admin),
            Ok(Caller::Scoped { .. }) => Err(AuthError::NotAdmin),
            Err(e) => Err(e),
        })
    }
}
