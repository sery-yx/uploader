use std::{
    fmt, io,
    pin::Pin,
    task::{Context, Poll},
};

use actix_web::{error::PayloadError, http::header::ContentType, web, HttpRequest, HttpResponse};
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
    rng, tokens,
};

/// Sent by the home page with a raw `POST`, percent-encoded so any file name fits in a header.
const FILENAME_POST_HEADER: &str = "X-Upload-Filename";

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
    #[error("The file is larger than the {0} MiB limit")]
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
) -> Result<HttpResponse, UploadError> {
    let boundary = multer::parse_boundary(ct.as_ref()).map_err(UploadError::Multipart)?;
    let mut form = multer::Multipart::new(SendPayload(body), boundary);
    // The first field is the file (ShareX and Chatterino both send exactly one).
    let mut field = form
        .next_field()
        .await
        .map_err(UploadError::Multipart)?
        .ok_or(UploadError::Empty)?;
    let filename = field.file_name().map(str::to_owned);
    let result = store(&caller, &mut field, filename.as_deref()).await;
    if matches!(result, Err(UploadError::NotAllowed(_))) {
        // Read the rest of the form (the closing boundary, any extra fields) so the client
        // gets the 403 instead of a reset connection.
        drop(field);
        while let Ok(Some(mut extra)) = form.next_field().await {
            while let Ok(Some(_)) = extra.chunk().await {}
        }
    }
    result
}

pub async fn upload_post(
    caller: Caller,
    mut body: web::Payload,
    req: HttpRequest,
) -> Result<HttpResponse, UploadError> {
    let filename = req
        .headers()
        .get(FILENAME_POST_HEADER)
        .and_then(|h| h.to_str().ok())
        .map(str::to_owned);
    store(&caller, &mut body, filename.as_deref()).await
}

async fn store<S, E>(
    caller: &Caller,
    stream: &mut S,
    upload_name: Option<&str>,
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

    // A name the uploader gave wins (".jpeg" stays ".jpeg"); otherwise look at the bytes.
    let sniffed = sniff_extension(&head);
    let extension = upload_name
        .and_then(media::extension_of)
        .unwrap_or_else(|| sniffed.to_owned());
    if let Caller::Scoped { perms, .. } = caller {
        if !tokens::upload_allowed(perms, &extension, sniffed) {
            drain(stream, limit.saturating_sub(head.len() as u64)).await;
            return Err(UploadError::NotAllowed(tokens::describe(perms)));
        }
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

/// Reads and discards the rest of a refused upload (up to `budget` bytes), so the client is
/// done sending and actually sees the error instead of a reset connection.
async fn drain<S, E>(stream: &mut S, budget: u64)
where
    S: Stream<Item = Result<Bytes, E>> + Unpin,
{
    let mut seen = 0u64;
    while let Some(Ok(chunk)) = stream.next().await {
        seen += chunk.len() as u64;
        if seen > budget {
            break;
        }
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
        Err(UploadError::TooLarge(CONFIG.max_upload_mib))
    } else {
        Ok(())
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
