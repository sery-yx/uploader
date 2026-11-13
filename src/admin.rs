//! Key management for the admin, plus `GET /api/key` so a page can see what its key may do.

use std::collections::BTreeSet;

use actix_web::{delete, get, post, put, web, HttpResponse};
use serde::{Deserialize, Serialize};

use crate::{
    auth::{Admin, Caller},
    tokens::{KeyInfo, Perm, StoreError, KEYS},
};

#[derive(Debug, thiserror::Error, actix_web_error::Json)]
pub enum AdminError {
    #[error("No key has that id")]
    #[status(404)]
    NotFound,
    #[error("{0}")]
    #[status(400)]
    Invalid(&'static str),
    #[error("Couldn't save the key list")]
    #[status(500)]
    Io,
}

impl From<StoreError> for AdminError {
    fn from(e: StoreError) -> Self {
        match e {
            StoreError::NotFound => AdminError::NotFound,
            StoreError::Invalid(msg) => AdminError::Invalid(msg),
            StoreError::Io(io) => {
                tracing::error!(error = %io, "Couldn't save the key list");
                AdminError::Io
            }
        }
    }
}

#[derive(Serialize)]
struct WhoAmI {
    admin: bool,
    /// The admin key has no name.
    name: Option<String>,
    perms: BTreeSet<Perm>,
}

/// What the sent key may do. Any valid key may ask.
#[get("/api/key")]
pub async fn whoami(caller: Caller) -> HttpResponse {
    let name = match &caller {
        Caller::Admin => None,
        Caller::Scoped { name, .. } => Some(name.clone()),
    };
    HttpResponse::Ok()
        .insert_header(("Cache-Control", "no-store"))
        .json(WhoAmI {
            admin: caller.is_admin(),
            name,
            perms: caller.perms(),
        })
}

#[derive(Deserialize)]
pub struct KeyForm {
    name: String,
    perms: BTreeSet<Perm>,
}

/// A key value is only ever sent back here, right after it's made or reset.
#[derive(Serialize)]
struct NewKey {
    token: String,
    key: KeyInfo,
}

fn keys_write() -> std::sync::RwLockWriteGuard<'static, crate::tokens::KeyStore> {
    KEYS.write().unwrap_or_else(|e| e.into_inner())
}

#[get("/api/keys")]
pub async fn list(_: Admin) -> HttpResponse {
    let keys = KEYS.read().unwrap_or_else(|e| e.into_inner()).list();
    HttpResponse::Ok()
        .insert_header(("Cache-Control", "no-store"))
        .json(keys)
}

#[post("/api/keys")]
pub async fn create(_: Admin, form: web::Json<KeyForm>) -> Result<HttpResponse, AdminError> {
    let (token, key) = keys_write().create(&form.name, form.perms.clone())?;
    tracing::info!(id = %key.id, name = %key.name, "Created an upload key");
    Ok(HttpResponse::Created()
        .insert_header(("Cache-Control", "no-store"))
        .json(NewKey { token, key }))
}

#[put("/api/keys/{id}")]
pub async fn update(
    _: Admin,
    id: web::Path<String>,
    form: web::Json<KeyForm>,
) -> Result<HttpResponse, AdminError> {
    let key = keys_write().update(&id, &form.name, form.perms.clone())?;
    Ok(HttpResponse::Ok().json(key))
}

#[post("/api/keys/{id}/reset")]
pub async fn reset(_: Admin, id: web::Path<String>) -> Result<HttpResponse, AdminError> {
    let (token, key) = keys_write().reset(&id)?;
    tracing::info!(id = %key.id, name = %key.name, "Reset an upload key");
    Ok(HttpResponse::Ok()
        .insert_header(("Cache-Control", "no-store"))
        .json(NewKey { token, key }))
}

#[delete("/api/keys/{id}")]
pub async fn remove(_: Admin, id: web::Path<String>) -> Result<HttpResponse, AdminError> {
    keys_write().delete(&id)?;
    tracing::info!(id = %id, "Deleted an upload key");
    Ok(HttpResponse::NoContent().finish())
}
