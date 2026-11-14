use std::{
    fmt, io,
    pin::Pin,
    task::{Context, Poll},
};

use actix_web::{
    error::PayloadError,
    http::header::{ContentType, CONTENT_LENGTH},
    web, HttpRequest, HttpResponse,
};
use bytes::{Bytes, BytesMut};
use futures::{Stream, StreamExt};
use serde::Serialize;
use tokio::io::AsyncWriteExt;
use tracing::warn;

use crate::{
    auth::Caller,
    config::CONFIG,
    deletion,
    media::{self, Kind},
    rng,
};

/// Sent by the home page with a raw `POST`, percent-encoded so any file name fits in a header.
const FILENAME_POST_HEADER: &str = "X-Upload-Filename";

/// What a multipart body may add on top of the file: boundaries and part headers.
const MULTIPART_OVERHEAD: u64 = 64 * 1024;

/// How much of the start of a file we look at to guess its type.
const SNIFF_LEN: usize = 512;

#[derive(Debug, thiserror::Error, actix_web_error::Json)]
pub enum UploadError {
    #[error("The upload has no file in it")]
    #[status(400)]
    Empty,
    #[error("Couldn't read the form: {0}")]
    #[status(400)]
    Multipart(multer::Error),
    /// Carries the limit in bytes that the upload was checked against.
    #[error("The file is larger than the {} limit", crate::media::format_size(*.0))]
    #[status(413)]
    TooLarge(u64),
    #[error("The upload was interrupted: {0}")]
    #[status(400)]
    Interrupted(String),
    #[error("This key can only upload {0}")]
    #[status(403)]
    NotAllowed(String),
    #[error("Couldn't save the file")]
    #[status(500)]
    Io(#[from] io::Error),
}

#[derive(Serialize)]
pub struct UploadResponse {
    link: String,
    deletion_link: String,
    /// `image`, `video`, `audio`, `text` or `file`. Additive; existing clients ignore it.
    kind: &'static str,
}

pub async fn upload_multipart(
    caller: Caller,
    body: web::Payload,
    ct: web::Header<ContentType>,
    req: HttpRequest,
) -> Result<HttpResponse, UploadError> {
    let limit = CONFIG.max_upload_bytes();
    check_declared(&req, limit.saturating_add(MULTIPART_OVERHEAD), limit)?;
    let boundary = multer::parse_boundary(ct.as_ref()).map_err(UploadError::Multipart)?;
    let mut form = multer::Multipart::new(SendPayload(body), boundary);
    // The first field is the file (ShareX and Chatterino both send exactly one).
    let mut field = form
        .next_field()
        .await
        .map_err(UploadError::Multipart)?
        .ok_or(UploadError::Empty)?;
    let filename = field.file_name().map(str::to_owned);
    // One budget for everything we read and throw away after a refusal.
    let mut spare = drain_budget(limit);
    let result = store(&caller, &mut field, filename.as_deref(), &mut spare).await;
    if matches!(result, Err(UploadError::NotAllowed(_))) {
        // Read the rest of the form (the closing boundary, any extra fields) so the client
        // gets the 403 instead of a reset connection.
        drop(field);
        'extras: while spare > 0 {
            let Ok(Some(mut extra)) = form.next_field().await else {
                break;
            };
            while let Ok(Some(chunk)) = extra.chunk().await {
                spare = spare.saturating_sub(chunk.len() as u64);
                if spare == 0 {
                    break 'extras;
                }
            }
        }
    }
    result
}

pub async fn upload_post(
    caller: Caller,
    mut body: web::Payload,
    req: HttpRequest,
) -> Result<HttpResponse, UploadError> {
    let limit = CONFIG.max_upload_bytes();
    check_declared(&req, limit, limit)?;
    let filename = req
        .headers()
        .get(FILENAME_POST_HEADER)
        .and_then(|h| h.to_str().ok())
        .map(str::to_owned);
    let mut spare = drain_budget(limit);
    store(&caller, &mut body, filename.as_deref(), &mut spare).await
}

/// How much of a refused upload is read and thrown away so the client sees the 403. Small, so a
/// key that may not upload something can't keep the server reading gigabytes for nothing; past
/// it the connection is closed.
const DRAIN_LIMIT: u64 = 8 * 1024 * 1024;

fn drain_budget(limit: u64) -> u64 {
    limit.min(DRAIN_LIMIT)
}

async fn store<S, E>(
    caller: &Caller,
    stream: &mut S,
    upload_name: Option<&str>,
    spare: &mut u64,
) -> Result<HttpResponse, UploadError>
where
    S: Stream<Item = Result<Bytes, E>> + Unpin,
    E: fmt::Display,
{
    let limit = CONFIG.max_upload_bytes();
    let head = read_head(stream).await?;
    if head.is_empty() {
        return Err(UploadError::Empty);
    }
    check_size(head.len() as u64, limit)?;
    *spare = spare.saturating_sub(head.len() as u64);

    // A name the uploader gave wins (".jpeg" stays ".jpeg"); otherwise look at the bytes.
    let sniffed = sniff_extension(&head);
    let extension = upload_name
        .and_then(media::extension_of)
        .unwrap_or_else(|| sniffed.to_owned());
    if let Err(allowed) = caller.may_upload(&extension, sniffed) {
        drain(stream, spare).await;
        return Err(UploadError::NotAllowed(allowed));
    }
    // The file is written under a dot-name (never served: `is_valid_stored_name` refuses it) and
    // renamed into place only once it's complete. The guard removes it on every other exit,
    // including the handler being dropped when the client disconnects or cancels.
    let (filename, mut file, partial) = create_partial(&extension).await?;

    let written = async {
        file.write_all(&head).await?;
        let mut total = head.len() as u64;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| UploadError::Interrupted(e.to_string()))?;
            total += chunk.len() as u64;
            check_size(total, limit)?;
            file.write_all(&chunk).await?;
        }
        file.flush().await?;
        drop(file);
        let target = CONFIG.file_dir.join(&filename);
        if tokio::fs::try_exists(&target).await? {
            // A name collision since we picked it; vanishingly rare, never overwrite.
            return Err(UploadError::Io(io::Error::from(
                io::ErrorKind::AlreadyExists,
            )));
        }
        tokio::fs::rename(&partial.path, &target).await?;
        Ok::<_, UploadError>(())
    }
    .await;

    match written {
        Ok(()) => partial.disarm(),
        Err(e) => {
            warn!(error = %e, file = %filename, "Upload failed, removing the partial file");
            return Err(e);
        }
    }

    let domain = CONFIG.domain();
    Ok(HttpResponse::Ok().json(UploadResponse {
        link: format!("{domain}/{filename}"),
        deletion_link: format!("{domain}/d/{filename}/{}", deletion::make_key(&filename)),
        kind: Kind::from_extension(&extension).as_str(),
    }))
}

/// Reads and discards the rest of a refused upload while `budget` lasts (and takes what it
/// reads off it), so the client is done sending and actually sees the error instead of a reset
/// connection.
async fn drain<S, E>(stream: &mut S, budget: &mut u64)
where
    S: Stream<Item = Result<Bytes, E>> + Unpin,
{
    while *budget > 0 {
        let Some(Ok(chunk)) = stream.next().await else {
            break;
        };
        *budget = budget.saturating_sub(chunk.len() as u64);
    }
}

/// Picks a free name and creates its partial file, retrying on the rare collision.
async fn create_partial(
    extension: &str,
) -> Result<(String, tokio::fs::File, PartialFile), UploadError> {
    for _ in 0..8 {
        let filename = format!("{}.{extension}", rng::generate_name());
        if tokio::fs::try_exists(CONFIG.file_dir.join(&filename)).await? {
            continue;
        }
        let path = CONFIG.file_dir.join(format!(".{filename}.part"));
        match tokio::fs::File::create_new(&path).await {
            Ok(file) => return Ok((filename, file, PartialFile { path, armed: true })),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.into()),
        }
    }
    Err(UploadError::Io(io::Error::from(
        io::ErrorKind::AlreadyExists,
    )))
}

/// Removes an unfinished upload when dropped, unless disarmed after the final rename.
struct PartialFile {
    path: std::path::PathBuf,
    armed: bool,
}

impl PartialFile {
    fn disarm(mut self) {
        self.armed = false;
    }
}

impl Drop for PartialFile {
    fn drop(&mut self) {
        if self.armed {
            if let Err(e) = std::fs::remove_file(&self.path) {
                if e.kind() != io::ErrorKind::NotFound {
                    warn!(error = %e, path = %self.path.display(), "Couldn't remove a partial upload");
                }
            }
        }
    }
}

fn check_size(total: u64, limit: u64) -> Result<(), UploadError> {
    if total > limit {
        Err(UploadError::TooLarge(limit))
    } else {
        Ok(())
    }
}

/// The size the client says the body will be, if it sent a usable `Content-Length`.
fn declared_length(req: &HttpRequest) -> Option<u64> {
    req.headers()
        .get(CONTENT_LENGTH)?
        .to_str()
        .ok()?
        .trim()
        .parse()
        .ok()
}

/// Refuses a body that says it's too big before we read any of it. `allowed` is the most the
/// body may be; `limit` is the file limit shown in the error.
fn check_declared(req: &HttpRequest, allowed: u64, limit: u64) -> Result<(), UploadError> {
    match declared_length(req) {
        Some(len) if len > allowed => Err(UploadError::TooLarge(limit)),
        _ => Ok(()),
    }
}

/// Reads at least [`SNIFF_LEN`] bytes (or the whole stream, if it's shorter).
async fn read_head<S, E>(stream: &mut S) -> Result<Bytes, UploadError>
where
    S: Stream<Item = Result<Bytes, E>> + Unpin,
    E: fmt::Display,
{
    let mut buf = BytesMut::new();
    while buf.len() < SNIFF_LEN {
        match stream.next().await {
            Some(Ok(chunk)) if buf.is_empty() && chunk.len() >= SNIFF_LEN => return Ok(chunk),
            Some(Ok(chunk)) => buf.extend_from_slice(&chunk),
            Some(Err(e)) => return Err(UploadError::Interrupted(e.to_string())),
            None => break,
        }
    }
    Ok(buf.freeze())
}

fn sniff_extension(head: &[u8]) -> &'static str {
    if let Some(ty) = infer::get(head) {
        // infer knows "html" and "xml"; never store something a browser would run.
        return match ty.extension() {
            "html" | "htm" | "xhtml" => "txt",
            ext => ext,
        };
    }
    if looks_like_text(head) {
        "txt"
    } else {
        "bin"
    }
}

/// Valid UTF-8, allowing the sample to end in the middle of a character.
fn looks_like_text(head: &[u8]) -> bool {
    match std::str::from_utf8(head) {
        Ok(s) => !s.contains('\0'),
        Err(e) => e.error_len().is_none() && !head[..e.valid_up_to()].contains(&0),
    }
}

/// `multer` wants a `Send` stream; actix's `Payload` isn't, but every handler future runs on the
/// single-threaded worker that created it, so the payload is never moved across threads.
struct SendPayload(web::Payload);

// SAFETY: see the type's docs. actix-web workers are `!Send` runtimes; the stream never leaves
// the worker thread it was created on.
unsafe impl Send for SendPayload {}

impl Stream for SendPayload {
    type Item = Result<Bytes, PayloadError>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        Pin::new(&mut self.0).poll_next(cx)
    }

    fn size_hint(&self) -> (usize, Option<usize>) {
        self.0.size_hint()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn too_large_names_the_limit_it_was_checked_against() {
        assert!(check_size(10, 10).is_ok());
        let err = check_size(3 * 1024 * 1024 + 1, 3 * 1024 * 1024).unwrap_err();
        assert_eq!(err.to_string(), "The file is larger than the 3 MB limit");
    }

    #[test]
    fn content_length_is_checked_early() {
        let req = |len: &str| {
            actix_web::test::TestRequest::default()
                .insert_header((CONTENT_LENGTH, len))
                .to_http_request()
        };
        let mib = 1024 * 1024;
        assert!(check_declared(&req("1048576"), mib, mib).is_ok());
        assert!(check_declared(&req("1048577"), mib, mib).is_err());
        assert!(check_declared(&req("1048577"), mib + MULTIPART_OVERHEAD, mib).is_ok());
        let none = actix_web::test::TestRequest::default().to_http_request();
        assert!(check_declared(&none, mib, mib).is_ok());
    }

    #[tokio::test]
    async fn drain_stops_when_the_budget_is_used() {
        let chunks: Vec<Result<Bytes, io::Error>> = (0..10)
            .map(|_| Ok(Bytes::from_static(b"0123456789")))
            .collect();
        let mut stream = futures::stream::iter(chunks);
        let mut budget = 25;
        drain(&mut stream, &mut budget).await;
        assert_eq!(budget, 0);
        assert_eq!(stream.count().await, 7);
    }

    #[test]
    fn sniffs_common_media() {
        assert_eq!(sniff_extension(b"GIF89a\x01\x00\x01\x00"), "gif");
        assert_eq!(sniff_extension(b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR"), "png");
        assert_eq!(
            sniff_extension(b"\0\0\0\x20ftypisom\0\0\x02\0isomiso2avc1mp41"),
            "mp4"
        );
        // infer only recognises WebM in a sample longer than 256 bytes; uploads read 512.
        let mut webm = b"\x1aE\xdf\xa3\x9fB\x86\x81\x01B\x82\x84webm".to_vec();
        webm.resize(SNIFF_LEN, 0);
        assert_eq!(sniff_extension(&webm), "webm");
    }

    #[test]
    fn sniffs_text_and_binary() {
        assert_eq!(sniff_extension("hello wörld".as_bytes()), "txt");
        // cut in the middle of "ö"
        assert_eq!(sniff_extension(&"hello wö".as_bytes()[..8]), "txt");
        assert_eq!(sniff_extension(b"\xff\xfe\x00\x01junk"), "bin");
        assert_eq!(
            sniff_extension(b"<!DOCTYPE html><html><body>x</body></html>"),
            "txt"
        );
    }

    #[tokio::test]
    async fn head_reads_across_small_chunks() {
        let chunks: Vec<Result<Bytes, io::Error>> = (0..100)
            .map(|_| Ok(Bytes::from_static(b"0123456789")))
            .collect();
        let mut stream = futures::stream::iter(chunks);
        let head = read_head(&mut stream).await.unwrap();
        assert!(head.len() >= SNIFF_LEN);
        let rest: usize = stream
            .map(|c| c.unwrap().len())
            .collect::<Vec<_>>()
            .await
            .iter()
            .sum();
        assert_eq!(head.len() + rest, 1000);
    }
}
