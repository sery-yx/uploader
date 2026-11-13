import {
  copy,
  el,
  errorMessage,
  formatDate,
  formatSize,
  groupThousands,
  icon,
  KEY_STORAGE,
  PERM_LABELS,
  PERM_NOUNS,
  describePerms,
  forgetWho,
  setLabel,
  store,
  toast,
  whoami,
} from './ui.js';
const RECENT_STORAGE = 'cyexUploaderRecent';
const RECENT_MAX = 30;

const $ = id => document.getElementById(id);
const home = $('home');
const maxBytes = Number(home.dataset.maxBytes);
const maxLabel = home.dataset.maxLabel;

// ---------- upload key ----------

const keyForm = $('key-form');
const uploader = $('uploader');

/** What the saved key may upload; every kind until the server says otherwise. */
let allowed = new Set(Object.keys(PERM_LABELS));

function syncKey() {
  const has = Boolean(store.get(KEY_STORAGE));
  keyForm.hidden = has;
  uploader.hidden = !has;
}

/** Asks the server what the key may do and shapes the page to it. */
async function applyKey({ fresh = false } = {}) {
  const who = await whoami({ fresh });
  if (!who) return true; // offline or no key: leave the page as it is
  if (who.invalid) {
    store.set(KEY_STORAGE, null);
    forgetWho();
    syncKey();
    toast('That upload key isn’t valid.', {
      type: 'error',
      detail: 'It may have been reset or deleted. Ask for a new one.',
    });
    $('key-input').focus();
    return false;
  }
  allowed = new Set(who.perms);
  const all = allowed.size === Object.keys(PERM_LABELS).length;
  $('key-scope').hidden = all;
  $('key-scope').textContent = all
    ? ''
    : `${who.name ? `${who.name} · ` : ''}Can upload ${describePerms([...allowed])}`;
  // The picker offers only what the key may upload (dropping and pasting are checked below).
  fileInput.accept = allowed.has('file')
    ? ''
    : [
        allowed.has('image') && 'image/*',
        allowed.has('gif') && '.gif,image/gif',
        allowed.has('video') && 'video/*',
        allowed.has('audio') && 'audio/*',
        allowed.has('text') && 'text/*,.txt,.md,.log,.json,.csv',
      ]
        .filter(Boolean)
        .join(',');
  // With only one kind of upload there's nothing to switch between.
  document.querySelector('.segmented').hidden = !allowed.has('text');
  if (!allowed.has('text') && mode === 'text') setMode('file');
  if (picked) setFile(picked);
  return true;
}

const TEXT_EXTENSIONS = new Set(
  'txt md log json csv tsv yaml yml toml xml ini cfg conf env rs py go c h cpp hpp cs java kt js mjs ts tsx jsx svelte vue lua rb php ps1 bat zig sh sql'.split(
    ' ',
  ),
);

/** The permission a file needs, the same way the server decides (by type, GIFs separate). */
function permOf(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (file.type === 'image/gif' || ext === 'gif') return 'gif';
  const kind = kindOf(file);
  // Browsers leave many text formats untyped or call them application/*.
  if (kind === 'file' && TEXT_EXTENSIONS.has(ext)) return 'text';
  return kind;
}

keyForm.addEventListener('submit', async e => {
  e.preventDefault();
  const value = $('key-input').value.trim();
  if (!value) return;
  // It's sent as an HTTP header: printable ASCII only.
  if (!/^[!-~][ -~]*$/.test(value)) {
    toast('That key can’t be sent as a header.', {
      type: 'error',
      detail: 'Use the exact value from config.toml. It only has plain ASCII characters.',
    });
    return;
  }
  store.set(KEY_STORAGE, value);
  forgetWho();
  if (!(await applyKey({ fresh: true }))) return;
  $('key-input').value = '';
  syncKey();
  toast('Key saved.', { type: 'success' });
  $('drop').focus();
});

$('forget-key').addEventListener('click', () => {
  store.set(KEY_STORAGE, null);
  forgetWho();
  allowed = new Set(Object.keys(PERM_LABELS));
  syncKey();
  $('key-input').focus();
});

// ---------- tabs ----------

const tabs = [$('tab-file'), $('tab-text')];
let mode = 'file';

function setMode(next, focus = false) {
  mode = next;
  for (const tab of tabs) {
    const on = tab.id === `tab-${next}`;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    $(tab.getAttribute('aria-controls')).hidden = !on;
    if (on && focus) tab.focus();
  }
  syncSubmit();
}

for (const tab of tabs) {
  tab.addEventListener('click', () => setMode(tab.id.slice(4)));
  tab.addEventListener('keydown', e => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      setMode(mode === 'file' ? 'text' : 'file', true);
    }
  });
}

// ---------- picking a file ----------

const drop = $('drop');
const fileInput = $('file-input');
/** @type {File | null} */
let picked = null;
let previewUrl = null;

function kindOf(file) {
  const type = file.type.split('/')[0];
  if (type === 'image' || type === 'video' || type === 'audio' || type === 'text') return type;
  return 'file';
}

const KIND_ICON = {
  image: 'image',
  video: 'video',
  audio: 'music',
  text: 'file-text',
  file: 'file',
};
const KIND_LABEL = { image: 'Picture', video: 'Video', audio: 'Audio', text: 'Text', file: 'File' };

function setFile(file) {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  picked = file;
  const thumb = $('picked-thumb');
  thumb.replaceChildren();

  $('drop-empty').hidden = Boolean(file);
  $('picked').hidden = !file;
  if (file) {
    const kind = kindOf(file);
    $('picked-name').textContent = file.name || 'Pasted file';
    const label = file.type === 'image/gif' ? 'GIF' : KIND_LABEL[kind];
    $('picked-info').textContent = `${label} · ${formatSize(file.size)}`;
    if (kind === 'image' || kind === 'video') {
      previewUrl = URL.createObjectURL(file);
      const media = kind === 'image' ? el('img') : el('video');
      media.src = previewUrl;
      if (kind === 'image') media.alt = '';
      else {
        media.muted = true;
        media.preload = 'metadata';
      }
      thumb.append(media);
    } else {
      thumb.append(icon(KIND_ICON[kind]));
    }
    if (!allowed.has(permOf(file))) {
      toast(`This key can’t upload ${PERM_NOUNS[permOf(file)]}.`, {
        type: 'error',
        detail: `It can upload ${describePerms([...allowed])}.`,
      });
    } else if (file.size > maxBytes) {
      toast('That file is too large.', {
        type: 'error',
        detail: `It’s ${formatSize(file.size)}; the limit is ${maxLabel}.`,
      });
    }
  }
  fileInput.value = '';
  syncSubmit();
}

drop.addEventListener('click', e => {
  if (e.target.closest('#clear-file') || busy) return;
  fileInput.click();
});
drop.addEventListener('keydown', e => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target === drop && !busy) {
    e.preventDefault();
    fileInput.click();
  }
});
fileInput.addEventListener('change', () => fileInput.files?.[0] && setFile(fileInput.files[0]));
$('clear-file').addEventListener('click', e => {
  e.stopPropagation();
  setFile(null);
  drop.focus();
});

// Drop anywhere on the page; the drop zone lights up while files are over the window.
let dragDepth = 0;
const hasFiles = e => [...(e.dataTransfer?.types ?? [])].includes('Files');
addEventListener('dragenter', e => {
  if (!hasFiles(e) || uploader.hidden || busy) return;
  e.preventDefault();
  dragDepth++;
  drop.classList.add('over');
  if (mode !== 'file') setMode('file');
});
addEventListener('dragover', e => {
  if (hasFiles(e)) e.preventDefault();
});
addEventListener('dragleave', e => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) drop.classList.remove('over');
});
addEventListener('drop', e => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  drop.classList.remove('over');
  if (uploader.hidden || busy) return;
  const file = e.dataTransfer.files[0];
  if (file) setFile(file);
  if (e.dataTransfer.files.length > 1)
    toast('Only the first file was added.', { detail: 'Upload one file at a time.' });
});

// Paste a screenshot or a copied file. Text pastes go to the text box as usual.
addEventListener('paste', e => {
  if (uploader.hidden || busy) return;
  const file = [...(e.clipboardData?.files ?? [])][0];
  if (!file) return;
  e.preventDefault();
  setMode('file');
  // Screenshots arrive as "image.png"; give them a name worth keeping.
  const named =
    file.name && file.name !== 'image.png'
      ? file
      : new File(
          [file],
          `screenshot-${Date.now()}.${(file.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`,
          {
            type: file.type,
          },
        );
  setFile(named);
});

// ---------- text ----------

const textInput = $('text-input');
textInput.addEventListener('input', () => {
  const n = textInput.value.length;
  $('text-count').textContent = `${groupThousands(n)} ${n === 1 ? 'character' : 'characters'}`;
  syncSubmit();
});

// ---------- upload ----------

const form = $('upload-form');
const submit = $('submit');
let busy = false;
/** @type {XMLHttpRequest | null} */
let xhr = null;

function payload() {
  if (mode === 'file') return picked;
  if (!textInput.value) return null;
  return new File([textInput.value], 'text.txt', { type: 'text/plain' });
}

function syncSubmit() {
  const p = payload();
  submit.disabled = busy || !p || p.size > maxBytes || !allowed.has(permOf(p));
  // The file row already shows its size; text only shows it here.
  $('upload-hint').textContent = p && !busy && mode === 'text' ? formatSize(p.size) : '';
}

function setBusy(on) {
  busy = on;
  $('progress').hidden = !on;
  $('actions').hidden = on;
  drop.setAttribute('aria-disabled', String(on));
  textInput.disabled = on;
  for (const tab of tabs) tab.disabled = on;
  syncSubmit();
}

function setProgress(loaded, total) {
  const p = total > 0 ? loaded / total : 0;
  $('progress-bar').firstElementChild.style.setProperty('--p', String(p));
  $('progress-bar').setAttribute('aria-valuenow', String(Math.round(p * 100)));
  $('progress-text').textContent = `${Math.floor(p * 100)} %`;
}

form.addEventListener('submit', e => {
  e.preventDefault();
  const file = payload();
  if (!file || busy) return;
  if (file.size > maxBytes) {
    toast('That file is too large.', { type: 'error', detail: `The limit is ${maxLabel}.` });
    return;
  }
  upload(file);
});

$('cancel').addEventListener('click', () => xhr?.abort());

function upload(file) {
  setBusy(true);
  setProgress(0, file.size);
  $('result').hidden = true;

  xhr = new XMLHttpRequest();
  xhr.upload.addEventListener('progress', e =>
    setProgress(e.loaded, e.lengthComputable ? e.total : file.size),
  );
  xhr.addEventListener('load', () => {
    const req = xhr;
    xhr = null;
    setBusy(false);
    if (req.status >= 200 && req.status < 300) {
      try {
        const res = JSON.parse(req.responseText);
        if (!res.link || !res.deletion_link) throw new Error('missing links');
        done(file, res);
      } catch {
        toast('Couldn’t read the server’s answer.', {
          type: 'error',
          detail: 'The file may still have been saved.',
        });
      }
      return;
    }
    if (req.status === 401 || (req.status === 400 && /authorization/i.test(req.responseText))) {
      toast('The server didn’t accept your upload key.', {
        type: 'error',
        detail: 'Use Forget key and enter it again.',
      });
      restoreFocus();
      return;
    }
    toast('Couldn’t upload.', {
      type: 'error',
      detail: errorMessage(req.status, req.responseText),
    });
    restoreFocus();
  });
  xhr.addEventListener('error', () => {
    xhr = null;
    setBusy(false);
    toast('Couldn’t upload.', { type: 'error', detail: 'The connection failed. Try again.' });
    restoreFocus();
  });
  xhr.addEventListener('abort', () => {
    xhr = null;
    setBusy(false);
    toast('Upload canceled.');
    restoreFocus();
  });

  try {
    xhr.open('POST', '/upload');
    xhr.setRequestHeader('Authorization', store.get(KEY_STORAGE) ?? '');
    // Header values must be Latin-1; encoding keeps any file name intact (the server only needs
    // the extension). A lone surrogate can't be encoded, so fall back to the bare extension.
    let name;
    try {
      name = encodeURIComponent(file.name);
    } catch {
      name = `file.${file.name
        .split('.')
        .pop()
        .replace(/[^a-z0-9]/gi, '')}`;
    }
    xhr.setRequestHeader('X-Upload-Filename', name);
    if (file.type) xhr.setRequestHeader('Content-Type', file.type);
    xhr.send(file);
    $('cancel').focus();
  } catch (e) {
    xhr = null;
    setBusy(false);
    toast('Couldn’t start the upload.', { type: 'error', detail: e.message });
    restoreFocus();
  }
}

/** After a cancel or a failure the focused control is gone; put focus back somewhere useful. */
function restoreFocus() {
  (mode === 'file' ? (picked ? submit : drop) : textInput).focus();
}

function done(file, res) {
  $('result-link').value = res.link;
  $('result-open').href = res.link;
  $('result-delete').value = res.deletion_link;
  $('result').hidden = false;
  $('result').focus({ preventScroll: false });

  addRecent({
    link: res.link,
    deletion: res.deletion_link,
    name: file.name,
    kind: res.kind ?? kindOf(file),
    size: file.size,
    at: Date.now(),
  });

  if (mode === 'file') setFile(null);
  else {
    textInput.value = '';
    textInput.dispatchEvent(new Event('input'));
  }
}

for (const button of document.querySelectorAll('[data-copy]')) {
  button.addEventListener('click', () => copy($(button.dataset.copy).value, button));
}
for (const input of [$('result-link'), $('result-delete')]) {
  input.addEventListener('focus', () => input.select());
}
$('again').addEventListener('click', () => {
  $('result').hidden = true;
  (mode === 'file' ? drop : textInput).focus();
});

// ---------- recent uploads (this browser only) ----------

const recentList = $('recent-list');

function readRecent() {
  const list = store.json(RECENT_STORAGE, []);
  return Array.isArray(list) ? list.filter(r => r && typeof r.link === 'string') : [];
}

function addRecent(entry) {
  const list = [entry, ...readRecent()].slice(0, RECENT_MAX);
  store.set(RECENT_STORAGE, JSON.stringify(list));
  renderRecent();
}

function renderRecent() {
  const list = readRecent();
  recentList.replaceChildren();
  recentList.hidden = list.length === 0;
  $('recent-empty').hidden = list.length > 0;
  $('clear-recent').hidden = list.length === 0;

  for (const r of list) {
    const row = el('li', 'row');
    const thumb = el('div', 'thumb');
    if (r.kind === 'image') {
      const img = el('img');
      img.src = r.link;
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.addEventListener('error', () => img.replaceWith(icon('image')), { once: true });
      thumb.append(img);
    } else {
      thumb.append(icon(KIND_ICON[r.kind] ?? 'file'));
    }

    const meta = el('div', 'row-meta');
    const link = el('a', '', r.link.replace(/^https?:\/\//, ''));
    link.href = r.link;
    link.target = '_blank';
    link.rel = 'noopener';
    const detail = [r.name, formatSize(r.size ?? 0), formatDate(r.at)].filter(Boolean).join(' · ');
    meta.append(link, el('span', 'hint', detail));

    const tools = el('div', 'row-tools');
    const copyBtn = el('button', 'icon-btn small');
    copyBtn.type = 'button';
    copyBtn.append(icon('copy'));
    setLabel(copyBtn, 'Copy link');
    copyBtn.addEventListener('click', () => copy(r.link, copyBtn));

    const del = el('a', 'icon-btn small');
    del.href = r.deletion;
    del.target = '_blank';
    del.rel = 'noopener';
    del.append(icon('trash'));
    setLabel(del, 'Delete file');
    del.dataset.hint = 'Opens the deletion page.';

    tools.append(copyBtn, del);
    row.append(thumb, meta, tools);
    recentList.append(row);
  }
}

$('clear-recent').addEventListener('click', () => {
  store.set(RECENT_STORAGE, null);
  renderRecent();
  toast('List cleared.', { detail: 'The files themselves are still online.' });
});

// Keep the list in step with deletions made in another tab.
addEventListener('storage', e => e.key === RECENT_STORAGE && renderRecent());

syncKey();
setMode('file');
applyKey();
renderRecent();
