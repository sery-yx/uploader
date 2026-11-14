//! Server-rendered pages. Every page extends `templates/base.html`.

use std::fs::Metadata;

use actix_web::{
    http::{
        header::{self, HeaderValue},
        StatusCode,
    },
    route, HttpResponse,
};
use askama::Template;

use crate::{
    config::CONFIG,
    media::{self, Kind},
    tokens,
};

/// Pages only load our own scripts and styles, and only talk to our own origin.
const PAGE_CSP: &str = "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; \
                        style-src 'self'; script-src 'self'; connect-src 'self'; \
                        object-src 'none'; base-uri 'none'; form-action 'self'; \
                        frame-ancestors 'none'";

#[derive(Template)]
#[template(path = "home.html")]
struct HomeTemplate {
    max_upload: String,
    max_upload_bytes: u64,
    /// JSON for the page's scripts, see [`tokens::client_table`].
    kinds: String,
}

#[derive(Template)]
#[template(path = "view.html")]
struct ViewTemplate<'a> {
    name: &'a str,
    /// `image`, `video`, `audio`, `text` or `file`
    kind: &'static str,
    /// What people call it: Picture, GIF, Video, Audio, Text, File.
    kind_label: &'static str,
    ext: &'a str,
    mime: String,
    size: String,
    bytes: u64,
    date: String,
    raw: String,
    /// Absolute URLs for link previews.
    page_url: String,
    raw_url: String,
}

#[derive(Template)]
#[template(path = "delete.html")]
struct DeleteTemplate<'a> {
    name: &'a str,
    state: DeleteState,
}

/// What a deletion link points at right now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeleteState {
    /// The name or key doesn't check out.
    Invalid,
    /// The link is genuine but the file is already gone.
    Gone,
    /// The link is genuine and the file is there.
    Ready,
}

impl DeleteState {
    pub fn status(self) -> StatusCode {
        match self {
            DeleteState::Invalid => StatusCode::UNAUTHORIZED,
            DeleteState::Gone => StatusCode::NOT_FOUND,
            DeleteState::Ready => StatusCode::OK,
        }
    }
}

#[derive(Template)]
#[template(path = "admin.html")]
struct AdminTemplate {
    kinds: String,
}

#[derive(Template)]
#[template(path = "404.html")]
struct NotFoundTemplate;

fn render(template: &impl Template, status: StatusCode) -> HttpResponse {
    match template.render() {
        Ok(body) => HttpResponse::build(status)
            .content_type("text/html; charset=utf-8")
            .insert_header((header::CONTENT_SECURITY_POLICY, PAGE_CSP))
            .insert_header((header::CACHE_CONTROL, "no-cache"))
            .body(body),
        Err(e) => {
            tracing::error!(error = %e, "Couldn't render a page");
            HttpResponse::InternalServerError()
                .content_type("text/plain; charset=utf-8")
                .body("Couldn't render this page.")
        }
    }
}

#[route("/", method = "GET", method = "HEAD")]
pub async fn home() -> HttpResponse {
    render(
        &HomeTemplate {
            max_upload: media::format_size(CONFIG.max_upload_bytes()),
            max_upload_bytes: CONFIG.max_upload_bytes(),
            kinds: tokens::client_table().to_string(),
        },
        StatusCode::OK,
    )
}

#[route("/admin", method = "GET", method = "HEAD")]
pub async fn admin_page() -> HttpResponse {
    render(
        &AdminTemplate {
            kinds: tokens::client_table().to_string(),
        },
        StatusCode::OK,
    )
}

pub fn viewer(name: &str, meta: &Metadata) -> HttpResponse {
    let ext = media::extension_of_stored(name);
    let mime = media::mime_for_extension(ext);
    let kind = Kind::from_mime(&mime);
    let domain = CONFIG.domain();
    let template = ViewTemplate {
        name,
        kind: kind.as_str(),
        kind_label: tokens::Perm::for_extension(ext).singular(),
        ext,
        mime: mime.essence_str().to_owned(),
        size: media::format_size(meta.len()),
        bytes: meta.len(),
        date: meta.modified().map(media::format_date).unwrap_or_default(),
        raw: format!("/raw/{name}"),
        page_url: format!("{domain}/{name}"),
        raw_url: format!("{domain}/raw/{name}"),
    };
    let mut res = render(&template, StatusCode::OK);
    res.headers_mut()
        .insert(header::VARY, HeaderValue::from_static("Sec-Fetch-Dest"));
    res
}

pub fn delete_page(name: &str, state: DeleteState) -> HttpResponse {
    render(&DeleteTemplate { name, state }, state.status())
}

pub fn not_found() -> HttpResponse {
    render(&NotFoundTemplate, StatusCode::NOT_FOUND)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delete_state_maps_to_status() {
        assert_eq!(DeleteState::Invalid.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(DeleteState::Gone.status(), StatusCode::NOT_FOUND);
        assert_eq!(DeleteState::Ready.status(), StatusCode::OK);
    }
}
