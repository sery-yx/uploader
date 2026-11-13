use actix_cors::Cors;
use actix_files::{Files, NamedFile};
use actix_web::{
    dev::{fn_service, ServiceRequest, ServiceResponse},
    http,
    http::header,
    middleware::{Compress, DefaultHeaders},
    route, web, App, HttpServer, Responder,
};
use args::Args;
use clap::Parser;
use tracing::level_filters::LevelFilter;
use tracing_actix_web::TracingLogger;
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

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::builder()
                .with_default_directive(LevelFilter::INFO.into())
                .from_env_lossy(),
        )
        .init();

    std::fs::create_dir_all(&CONFIG.file_dir)?;

    let args = Args::parse();
    if let Some(cmd) = args.cmd {
        return cmd.run();
    };

    // Read the key list now, so a broken file stops the server at start instead of mid-request.
    let key_count = tokens::KEYS.read().map_or(0, |k| k.list().len());
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
            .wrap(TracingLogger::default())
            .wrap(Compress::default())
            .service(
                // Each upload handler checks the key itself (admin or a scoped key).
                web::resource("/upload")
                    .route(web::post().guard(MimeGuard).to(upload::upload_multipart))
                    .route(web::post().to(upload::upload_post)),
            )
            .service(
                Files::new("/static", "static")
                    .use_etag(true)
                    .use_last_modified(true)
                    .default_handler(fn_service(not_found_svc)),
            )
            .service(admin::whoami)
            .service(admin::list)
            .service(admin::create)
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
