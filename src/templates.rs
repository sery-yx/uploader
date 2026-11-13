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
    valid: bool,
    exists: bool,
}

#[derive(Template)]
#[template(path = "admin.html")]
struct AdminTemplate;

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
            max_upload: format!("{} MB", media::group_thousands(CONFIG.max_upload_mib)),
            max_upload_bytes: CONFIG.max_upload_bytes(),
        },
        StatusCode::OK,
    )
}

#[route("/admin", method = "GET", method = "HEAD")]
pub async fn admin_page() -> HttpResponse {
    render(&AdminTemplate, StatusCode::OK)
}

pub fn viewer(name: &str, meta: &Metadata) -> HttpResponse {
    let ext = media::extension_of_stored(name);
    let mime = media::mime_for_extension(ext);
    let kind = Kind::from_mime(&mime);
    let domain = CONFIG.domain();
    let template = ViewTemplate {
        name,
        kind: kind.as_str(),
        kind_label: kind_label(kind, ext),
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

fn kind_label(kind: Kind, ext: &str) -> &'static str {
    match kind {
        Kind::Image if ext.eq_ignore_ascii_case("gif") => "GIF",
        Kind::Image => "Picture",
        Kind::Video => "Video",
        Kind::Audio => "Audio",
        Kind::Text => "Text",
        Kind::Other => "File",
    }
}

pub fn delete_page(name: &str, valid: bool, exists: bool) -> HttpResponse {
    let status = match (valid, exists) {
        (false, _) => StatusCode::UNAUTHORIZED,
        (true, false) => StatusCode::NOT_FOUND,
        (true, true) => StatusCode::OK,
    };
    render(
        &DeleteTemplate {
            name,
            valid,
            exists,
        },
        status,
    )
}

pub fn not_found() -> HttpResponse {
    render(&NotFoundTemplate, StatusCode::NOT_FOUND)
}
