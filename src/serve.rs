//! Serving uploaded files: the raw bytes, or a viewer page when a person opens the link.

use actix_files::NamedFile;
use actix_web::{
    http::header::{self, HeaderValue},
    route, web, HttpRequest, HttpResponse,
};

use crate::{
    config::CONFIG,
    media::{self, Kind},
    templates,
};

/// Raw files are never allowed to act as a page on our origin (that's where the upload key
/// lives). `sandbox` gives them an opaque origin even if a browser decides to render one.
const RAW_CSP: &str = "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; \
                       style-src 'unsafe-inline'";

/// `/{name}`: a browser opening the link gets the viewer; `<img>`, `<video>`, embed bots and
/// command-line tools get the file itself. Browsers send `Sec-Fetch-Dest: document` only for
/// top-level navigations, so the same link works in both places.
#[route("/{name}", method = "GET", method = "HEAD")]
pub async fn file_or_viewer(req: HttpRequest, name: web::Path<String>) -> HttpResponse {
    if wants_page(&req) {
        viewer(&name).await
    } else {
        raw_file(&req, &name).await
    }
}

/// `/raw/{name}`: always the file itself (used by "Open original" and the viewers).
#[route("/raw/{name}", method = "GET", method = "HEAD")]
pub async fn raw(req: HttpRequest, name: web::Path<String>) -> HttpResponse {
    raw_file(&req, &name).await
}

/// Old upstream viewer links (`/a/x.mp3`, `/t/x.txt`) and explicit ones (`/i/`, `/v/`) keep
/// working and always show the viewer.
#[route("/{prefix:[ativ]}/{name}", method = "GET", method = "HEAD")]
pub async fn legacy_viewer(path: web::Path<(String, String)>) -> HttpResponse {
    viewer(&path.1).await
}

fn wants_page(req: &HttpRequest) -> bool {
    req.headers()
        .get("sec-fetch-dest")
        .is_some_and(|v| v.as_bytes() == b"document")
}

async fn viewer(name: &str) -> HttpResponse {
    if !media::is_valid_stored_name(name) {
        return templates::not_found();
    }
    let meta = match tokio::fs::metadata(CONFIG.file_dir.join(name)).await {
        Ok(m) if m.is_file() => m,
        _ => return templates::not_found(),
    };
    templates::viewer(name, &meta)
}

async fn raw_file(req: &HttpRequest, name: &str) -> HttpResponse {
    if !media::is_valid_stored_name(name) {
        return templates::not_found();
    }
    let named = match NamedFile::open(CONFIG.file_dir.join(name)) {
        Ok(f) => f,
        Err(_) => return templates::not_found(),
    };

    let mime = media::mime_for_extension(media::extension_of_stored(name));
    let kind = Kind::from_mime(&mime);
    let mime = if kind == Kind::Text && mime.get_param(mime::CHARSET).is_none() {
        format!("{mime}; charset=utf-8")
            .parse()
            .unwrap_or(mime::TEXT_PLAIN_UTF_8)
    } else {
        mime
    };

    // `Compress` already leaves pictures, video and byte ranges alone.
    let named = named
        .set_content_type(mime)
        .use_etag(true)
        .use_last_modified(true);

    let mut res = named.into_response(req);
    let headers = res.headers_mut();
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(RAW_CSP),
    );
    headers.insert(header::VARY, HeaderValue::from_static("Sec-Fetch-Dest"));
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=3600"),
    );
    res
}
