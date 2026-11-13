# uploader

A small private file uploader with a public viewer, forked from
[Nerixyz/uploader](https://github.com/Nerixyz/uploader) and restyled in the cyex design.
Only people with the upload key can upload; anyone with a link can open it.

## What it does

- Upload from the page (pick, drag in or paste a screenshot with Ctrl+V), ShareX, Chatterino or curl.
- **One link per file.** Opening it in a browser shows a viewer; `<img>`/`<video>` tags, chat
  embeds (Discord, Chatterino) and command-line tools get the file itself. `/raw/<name>` always
  returns the file.
- Viewers for **pictures and GIFs** (fit or full size, pixel art stays crisp), **video** and
  **audio** (custom player: seek, volume, speed, keep pitch, loop, full screen, `#t=1:23` links),
  **text and code** (line numbers, wrap, syntax highlighting), and a download card for anything else.
- File types come from the upload's name or, without one, from the file's first bytes.
- Recent uploads and their deletion links are kept in your browser.
- Dark and light themes.

## Running it

1. Copy `config.example.toml` to `config.toml` and fill it in:

   ```toml
   bind = "127.0.0.1:4833"
   file_dir = "uploads"
   domain = "https://i.example.com"   # public origin, no trailing slash
   authorization = "Bearer <token>"   # any long random value
   secret = "..."                     # `openssl rand -base64 28`, signs deletion links
   max_upload_mib = 256               # optional, default 256
   ```

2. `cargo run -r` (run it from the repository root, it serves `static/`).

Put it behind a reverse proxy for HTTPS. If the proxy limits body size, raise that limit to
match `max_upload_mib`.

### Cleaning

Remove old files with `cargo r -r -- clean` (`--max-age 1y`, `--metric modified|accessed|created`,
`--dry-run`).

## Keys

The `authorization` value in `config.toml` is the **admin key**: it can upload anything and
manage other keys. Signed in with it, open **Keys** (`/admin`) to:

- **Create** a key limited to any mix of pictures, GIFs, video, audio, text and other files
  (pictures don't include GIFs, so a key can be GIF-only). The key is shown once, with a
  ready-made ShareX config to download.
- **Edit** a key's name or what it may upload.
- **Reset** a key: it gets a new value and the old one stops working at once.
- **Delete** a key. Files uploaded with it stay online.

A scoped key is checked against both the file's name and its contents, so a video renamed to
`.gif` is refused by a GIF-only key (`403 This key can only upload GIFs`). Keys are stored hashed
(SHA-256) in `keys_file` (default `keys.json`); scoped keys look like `upl_…` and work with or
without a `Bearer ` prefix.

API (admin key in `Authorization`): `GET /api/keys`, `POST /api/keys {name, perms}`,
`PUT /api/keys/{id} {name, perms}`, `POST /api/keys/{id}/reset`, `DELETE /api/keys/{id}`.
`perms` is a list of `image`, `gif`, `video`, `audio`, `text`, `file`. Any key can call
`GET /api/key` to see what it may upload.

## Uploading

Send a `multipart/form-data` request to `/upload` (the first field is the file) or a raw `POST`
body, with the `Authorization` header set to the admin key or a scoped key. Raw posts can name the file
with an `X-Upload-Filename` header (percent-encoded); only its extension is used.

## Client configuration

### ShareX

Use the following ShareX config and replace `{config.domain}` and `{config.authorization}` with the respective values from your [`config.toml`](#running-it):

```json
{
  "Version": "14.1.0",
  "Name": "Uploader",
  "DestinationType": "ImageUploader, TextUploader, FileUploader",
  "RequestMethod": "POST",
  "RequestURL": "{config.domain}/upload",
  "Headers": {
    "Authorization": "{config.authorization}"
  },
  "Body": "MultipartFormData",
  "FileFormName": "file",
  "URL": "{json:link}",
  "DeletionURL": "{json:deletion_link}"
}
```

### Chatterino

Use the following configuration and replace `{config.domain}` and `{config.authorization}` with the respective values from your [`config.toml`](#running-it):

```json
{
  "external": {
    "imageUploader": {
      "enabled": true,
      "url": "{config.domain}/upload",
      "formField": "file",
      "headers": "Authorization: {config.authorization}",
      "link": "{link}",
      "deletionLink": "{deletion_link}"
    }
  }
}
```

<details>
<summary>Screenshot</summary>

![](https://user-images.githubusercontent.com/19953266/208187827-37564bf8-7dd3-48a2-9f7a-c007413249c0.png)

</details>

## Upload Response

```typescript
type UploadResponse =
  | {
      error: string;
    }
  | {
      link: string;
      deletion_link: string;
      kind: 'image' | 'video' | 'audio' | 'text' | 'file';
    };
```

## Security notes

- Raw files are served with `Content-Security-Policy: sandbox` and `nosniff`, so an uploaded
  SVG or HTML file can't run script on the uploader's origin (where the upload key is stored).
  `.html` uploads are stored as `.txt`.
- Pages only load the uploader's own scripts, styles and fonts.
- Deletion links are HMAC-SHA224 signatures of the file name, checked in constant time. Links made
  before the fork keep working with the same `secret`.

## Development

```sh
cargo test
cargo clippy --all-targets
npm run check-format   # prettier for static/ (templates are Askama and skipped)
```
