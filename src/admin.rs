//! Key management for the admin, plus `GET /api/key` so a page can see what its key may do.

use std::collections::BTreeSet;

use actix_web::{delete, get, post, put, web, HttpResponse};
use serde::{Deserialize, Serialize};

use crate::{
    auth::{Admin, Caller},
    tokens::{self, KeyInfo, Perm, StoreError},
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

#[get("/api/keys")]
pub async fn list(_: Admin) -> HttpResponse {
    let keys = tokens::keys().list();
    HttpResponse::Ok()
        .insert_header(("Cache-Control", "no-store"))
        .json(keys)
}

#[derive(Serialize)]
struct ShownKey {
    /// `None` for a key made before keys were kept; resetting it makes one that can be shown.
    token: Option<String>,
    key: KeyInfo,
}

/// The key itself, so the admin can copy it again without resetting it.
#[get("/api/keys/{id}/secret")]
pub async fn secret(_: Admin, id: web::Path<String>) -> Result<HttpResponse, AdminError> {
    let (token, key) = tokens::keys().secret(&id)?;
    Ok(HttpResponse::Ok()
        .insert_header(("Cache-Control", "no-store"))
        .json(ShownKey { token, key }))
}

#[post("/api/keys")]
pub async fn create(_: Admin, form: web::Json<KeyForm>) -> Result<HttpResponse, AdminError> {
    let (token, key) = tokens::keys_mut().create(&form.name, form.perms.clone())?;
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
    let key = tokens::keys_mut().update(&id, &form.name, form.perms.clone())?;
    Ok(HttpResponse::Ok().json(key))
}

#[post("/api/keys/{id}/reset")]
pub async fn reset(_: Admin, id: web::Path<String>) -> Result<HttpResponse, AdminError> {
    let (token, key) = tokens::keys_mut().reset(&id)?;
    tracing::info!(id = %key.id, name = %key.name, "Reset an upload key");
    Ok(HttpResponse::Ok()
        .insert_header(("Cache-Control", "no-store"))
        .json(NewKey { token, key }))
}

#[delete("/api/keys/{id}")]
pub async fn remove(_: Admin, id: web::Path<String>) -> Result<HttpResponse, AdminError> {
    tokens::keys_mut().delete(&id)?;
    tracing::info!(id = %id, "Deleted an upload key");
    Ok(HttpResponse::NoContent().finish())
}
