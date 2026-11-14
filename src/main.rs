use actix_cors::Cors;
use actix_files::{Files, NamedFile};
use actix_web::{
    body::MessageBody,
    dev::{fn_service, ServiceRequest, ServiceResponse},
    http,
    http::header,
    middleware::{Compress, DefaultHeaders},
    route, web, App, HttpServer, Responder,
};
use args::Args;
use clap::Parser;
use tracing::level_filters::LevelFilter;
use tracing_actix_web::{DefaultRootSpanBuilder, RootSpanBuilder, TracingLogger};
use tracing_subscriber::EnvFilter;

use crate::{config::CONFIG, guards::MimeGuard};

mod admin;
mod args;
mod auth;
mod clean;
mod config;
mod deletion;
mod guards;
mod media;
mod rng;
mod serve;
mod templates;
mod tokens;
mod upload;

async fn not_found_svc(req: ServiceRequest) -> Result<ServiceResponse, actix_web::Error> {
    let (req, _) = req.into_parts();
    Ok(ServiceResponse::new(req, templates::not_found()))
}

#[route("/favicon.ico", method = "GET", method = "HEAD")]
async fn favicon() -> impl Responder {
    NamedFile::open("./static/favicon.svg")
}

/// The request log's root span. Deletion links carry their key in the path (`/d/{name}/{key}`),
/// so those requests are logged by their route pattern instead of the raw target.
struct RedactedRootSpan;

impl RootSpanBuilder for RedactedRootSpan {
    fn on_request_start(request: &ServiceRequest) -> tracing::Span {
        let route = request.match_pattern().unwrap_or_else(|| "default".into());
        let target = log_target(request.uri().path(), &route);
        tracing::info_span!(
            "HTTP request",
            http.method = %request.method(),
            http.route = %route,
            http.target = %target,
            http.client_ip = %request.connection_info().realip_remote_addr().unwrap_or(""),
            http.status_code = tracing::field::Empty,
            otel.name = %format!("{} {route}", request.method()),
            otel.kind = "server",
            otel.status_code = tracing::field::Empty,
            exception.message = tracing::field::Empty,
            exception.details = tracing::field::Empty,
        )
    }

    fn on_request_end<B: MessageBody>(
        span: tracing::Span,
        outcome: &Result<ServiceResponse<B>, actix_web::Error>,
    ) {
        DefaultRootSpanBuilder::on_request_end(span, outcome);
    }
}

/// What to log as a request's target: the route pattern for `/d/` paths, the path otherwise
/// (query strings are left out; nothing here uses them).
fn log_target<'a>(path: &'a str, route: &'a str) -> &'a str {
    if path.starts_with("/d/") {
        route
    } else {
        path
    }
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::builder()
                .with_default_directive(LevelFilter::INFO.into())
                .from_env_lossy(),
        )
        .init();

    // Parse first, so `--help` and `--version` work without a config.toml.
    let args = Args::parse();
    if let Some(cmd) = args.cmd {
        return cmd.run();
    };

    std::fs::create_dir_all(&CONFIG.file_dir)?;

    // Read the key list now, so a broken file stops the server at start instead of mid-request.
    let key_count = tokens::keys().list().len();
    tracing::info!(bind = %CONFIG.bind, keys = key_count, max_upload_mib = CONFIG.max_upload_mib, "Starting");

    HttpServer::new(move || {
        App::new()
            .wrap(
                Cors::default()
                    .allow_any_origin()
                    .allowed_headers(&[header::ACCEPT, header::CONTENT_TYPE, header::RANGE])
                    .allowed_methods([http::Method::GET])
                    .max_age(60 * 60),
            )
            .wrap(
                DefaultHeaders::new()
                    .add((header::X_CONTENT_TYPE_OPTIONS, "nosniff"))
                    .add((header::REFERRER_POLICY, "strict-origin-when-cross-origin")),
            )
            .wrap(TracingLogger::<RedactedRootSpan>::new())
            .wrap(Compress::default())
            .service(
                // Each upload handler checks the key itself (admin or a scoped key).
                web::resource("/upload")
                    .route(web::post().guard(MimeGuard).to(upload::upload_multipart))
                    .route(web::post().to(upload::upload_post)),
            )
            .service(
                // `no-cache` makes browsers check the ETag on every load, so an update's CSS and
                // JS show up at once instead of an old copy running against new pages.
                web::scope("/static")
                    .wrap(DefaultHeaders::new().add((header::CACHE_CONTROL, "no-cache")))
                    .service(
                        Files::new("", "static")
                            .use_etag(true)
                            .use_last_modified(true)
                            .default_handler(fn_service(not_found_svc)),
                    ),
            )
            .service(admin::whoami)
            .service(admin::list)
            .service(admin::create)
            .service(admin::secret)
            .service(admin::update)
            .service(admin::reset)
            .service(admin::remove)
            .service(templates::admin_page)
            .service(deletion::delete_file)
            .service(deletion::delete_page)
            .service(templates::home)
            .service(favicon)
            .service(serve::raw)
            .service(serve::legacy_viewer)
            .service(serve::file_or_viewer)
            .default_service(fn_service(not_found_svc))
    })
    .bind(&CONFIG.bind)?
    .run()
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deletion_keys_stay_out_of_the_log() {
        assert_eq!(
            log_target("/d/abc.png/SECRET", "/d/{filename}/{key}"),
            "/d/{filename}/{key}"
        );
        assert_eq!(log_target("/abc.png", "/{name}"), "/abc.png");
    }
}
