import {
  KEY_STORAGE,
  STORAGE,
  confirmAction,
  copy,
  describePerms,
  el,
  errorMessage,
  forgetWho,
  formatDate,
  formatSize,
  groupThousands,
  icon,
  kinds,
  perm,
  permOfFile,
  setLabel,
  store,
  syncNav,
  toast,
  whoami,
} from './ui.js';

const RECENT_MAX = 30;

const $ = id => document.getElementById(id);
const home = $('home');
const maxBytes = Number(home.dataset.maxBytes);
const maxLabel = home.dataset.maxLabel;

// ---------- page state (all of it, declared before anything reads it) ----------

const keyForm = $('key-form');
const keyInput = $('key-input');
const uploader = $('uploader');
const tabs = [$('tab-file'), $('tab-text')];
const drop = $('drop');
const pickedBox = $('picked');
const fileInput = $('file-input');
const textInput = $('text-input');
const form = $('upload-form');
const submit = $('submit');
const recentList = $('recent-list');

const ALL_PERMS = () => kinds().perms.map(p => p.id);
/** What the saved key may upload; everything until the server says otherwise. */
let allowed = new Set(ALL_PERMS());
let mode = 'file';
/** @type {File | null} */
let picked = null;
let previewUrl = null;
let busy = false;
/** @type {XMLHttpRequest | null} */
let xhr = null;
let dragDepth = 0;

// ---------- upload key ----------

function syncKey() {
  const has = Boolean(store.get(KEY_STORAGE));
  keyForm.hidden = has;
  uploader.hidden = !has;
}

function keyError(message) {
  $('key-error').textContent = message ?? '';
  $('key-error').hidden = !message;
  if (message) keyInput.setAttribute('aria-invalid', 'true');
  else keyInput.removeAttribute('aria-invalid');
}

/** Drops the saved key and everything picked with it, and asks for a key again. */
function forgetKey(message) {
  store.set(KEY_STORAGE, null);
  forgetWho();
  syncNav(null);
  allowed = new Set(ALL_PERMS());
  setFile(null);
  textInput.value = '';
  textInput.dispatchEvent(new Event('input'));
  syncKey();
  keyError(message);
  keyInput.focus();
}

/** Asks the server what the key may do and shapes the page to it. */
async function applyKey({ fresh = false } = {}) {
  const who = await whoami({ fresh });
  if (!who) return true; // offline: leave the page as it is, the server still checks
  if (who.invalid) {
    forgetKey('That key isn’t valid. It may have been reset or deleted; ask for a new one.');
    return false;
  }
  syncNav(who);
  allowed = new Set(who.perms);
  const all = allowed.size === ALL_PERMS().length;
  // Say what this key may upload instead of everything the server takes.
  $('home-sub').textContent = all
    ? `Pictures, GIFs, video, audio, text or any other file, up to ${maxLabel}.`
    : `${capitalise(describePerms([...allowed]))}, up to ${maxLabel}.`;
  $('key-scope').hidden = all;
  $('key-scope').textContent = all
    ? ''
    : `${who.name ? `${who.name} · ` : ''}Can upload ${describePerms([...allowed])}`;
  // The picker offers what the key may upload; drops and pastes are checked in setFile.
  fileInput.accept = allowed.has('file')
    ? ''
    : Object.entries(kinds().exts)
        .filter(([, p]) => allowed.has(p))
        .map(([ext]) => `.${ext}`)
        .join(',');
  // With only one kind of upload there's nothing to switch between.
  document.querySelector('.segmented').hidden = !allowed.has('text');
  if (!allowed.has('text') && mode === 'text') setMode('file');
  if (picked) setFile(picked);
  return true;
}

keyForm.addEventListener('submit', async e => {
  e.preventDefault();
  const value = keyInput.value.trim();
  if (!value) {
    keyError('Enter your upload key first.');
    keyInput.focus();
    return;
  }
  // It's sent as an HTTP header: printable ASCII only.
  if (!/^[!-~][ -~]*$/.test(value)) {
    keyError('Upload keys only use plain ASCII characters. Copy the exact value you were given.');
    return;
  }
  keyError(null);
  store.set(KEY_STORAGE, value);
  forgetWho();
  if (!(await applyKey({ fresh: true }))) return;
  keyInput.value = '';
  syncKey();
  toast('Key saved.', { type: 'success' });
  drop.focus();
});
keyInput.addEventListener('input', () => keyError(null));

$('forget-key').addEventListener('click', async e => {
  const ok = await confirmAction(e.currentTarget, {
    title: 'Forget the key in this browser?',
    detail: 'You’ll need to paste it again to upload. The key itself keeps working.',
    action: 'Forget key',
  });
  if (ok) forgetKey();
});

// ---------- tabs ----------

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
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
      e.preventDefault();
      setMode(mode === 'file' ? 'text' : 'file', true);
    }
  });
}

// ---------- picking a file ----------

const KIND_ICON = {
  image: 'image',
  gif: 'image',
  video: 'video',
  audio: 'music',
  text: 'file-text',
};

function setFile(file) {
  // Remove the old preview before releasing its URL, so it doesn't try to load a dead blob.
  const thumb = $('picked-thumb');
  thumb.replaceChildren();
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  picked = file;

  drop.hidden = Boolean(file);
  pickedBox.hidden = !file;
  if (file) {
    const p = permOfFile(file);
    $('picked-name').textContent = file.name || 'Pasted file';
    $('picked-name').title = file.name || '';
    $('picked-info').textContent = `${perm(p)?.one ?? 'File'} · ${formatSize(file.size)}`;
    const top = file.type.split('/')[0];
    if (top === 'image' || top === 'video') {
      previewUrl = URL.createObjectURL(file);
      const media = el(top === 'image' ? 'img' : 'video');
      media.src = previewUrl;
      if (top === 'image') media.alt = '';
      else {
        media.muted = true;
        media.preload = 'metadata';
      }
      thumb.append(media);
    } else {
      thumb.append(icon(KIND_ICON[p] ?? 'file'));
    }
    // The reason also stays under the file (see syncSubmit); the toast is the alert.
    if (!allowed.has(p)) {
      toast(`This key can’t upload ${perm(p)?.noun ?? 'this file'}.`, {
        type: 'error',
        detail: `It can upload ${describePerms([...allowed])}.`,
      });
    } else if (file.size > maxBytes) {
      toast('That file is too large.', { type: 'error', detail: sizeError(file.size) });
    } else if (file.size === 0) {
      toast('That file is empty.', { type: 'error', detail: 'There’s nothing in it to upload.' });
    }
  }
  fileInput.value = '';
  syncSubmit();
}

const capitalise = s => s.charAt(0).toUpperCase() + s.slice(1);

/** "It's 50,2 MB; the limit is 50 MB.", exact bytes when the rounded sizes would look equal. */
function sizeError(size) {
  const shown = formatSize(size);
  const exact = shown === maxLabel ? `${groupThousands(size)} bytes` : shown;
  return `It’s ${exact}; the limit is ${maxLabel}.`;
}

const choose = () => !busy && fileInput.click();
drop.addEventListener('click', choose);
drop.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    choose();
  }
});
$('change-file').addEventListener('click', choose);
fileInput.addEventListener('change', () => fileInput.files?.[0] && setFile(fileInput.files[0]));
$('clear-file').addEventListener('click', () => {
  setFile(null);
  drop.focus();
});

// Drop anywhere on the page; the drop zone lights up while files are over the window.
const hasFiles = e => [...(e.dataTransfer?.types ?? [])].includes('Files');
const dropTarget = () => (picked ? pickedBox : drop);
addEventListener('dragenter', e => {
  if (!hasFiles(e) || uploader.hidden || busy) return;
  e.preventDefault();
  dragDepth++;
  dropTarget().classList.add('over');
  if (mode !== 'file') setMode('file');
});
addEventListener('dragover', e => {
  if (hasFiles(e)) e.preventDefault();
});
addEventListener('dragleave', e => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) (drop.classList.remove('over'), pickedBox.classList.remove('over'));
});
addEventListener('drop', e => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  drop.classList.remove('over');
  pickedBox.classList.remove('over');
  if (uploader.hidden || busy) return;
  const file = e.dataTransfer.files[0];
  if (file) setFile(file);
  if (e.dataTransfer.files.length > 1)
    toast('Only the first file was added.', { detail: 'Upload one file at a time.' });
});

/** `screenshot-2026-11-13-180502.png` in local time. */
function screenshotName(type) {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `screenshot-${stamp}.${(type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`;
}

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
      : new File([file], screenshotName(file.type), { type: file.type });
  setFile(named);
});

// ---------- text ----------

textInput.addEventListener('input', () => {
  // Count characters as people see them, not UTF-16 units (an emoji is one).
  const n = [...textInput.value].length;
  $('text-count').textContent = `${groupThousands(n)} ${n === 1 ? 'character' : 'characters'}`;
  syncSubmit();
});

// ---------- upload ----------

function payload() {
  if (mode === 'file') return picked;
  if (!textInput.value) return null;
  return new File([textInput.value], 'text.txt', { type: 'text/plain' });
}

/** Why this payload can't be uploaded, or null. */
function blocked(p) {
  if (!allowed.has(permOfFile(p)))
    return `This key can’t upload ${perm(permOfFile(p))?.noun ?? 'this file'}. It can upload ${describePerms([...allowed])}.`;
  if (p.size > maxBytes) return `Too large. ${sizeError(p.size)}`;
  if (p.size === 0) return 'This file is empty.';
  return null;
}

function syncSubmit() {
  const p = payload();
  const reason = p && blocked(p);
  submit.disabled = busy || !p || Boolean(reason);
  const hint = $('upload-hint');
  hint.classList.toggle('bad', Boolean(reason) && !busy);
  // The file row already shows its size; text only shows it here.
  hint.textContent = !p || busy ? '' : (reason ?? (mode === 'text' ? formatSize(p.size) : ''));
}

function setBusy(on) {
  busy = on;
  $('progress').hidden = !on;
  $('actions').hidden = on;
  drop.setAttribute('aria-disabled', String(on));
  $('change-file').disabled = on;
  $('clear-file').disabled = on;
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
    toast('That file is too large.', { type: 'error', detail: sizeError(file.size) });
    return;
  }
  upload(file);
});

$('cancel').addEventListener('click', () => xhr?.abort());

/** After a cancel or a failure the focused control is gone; put focus back somewhere useful. */
function restoreFocus() {
  (mode === 'file' ? (picked ? submit : drop) : textInput).focus();
}

/** Every way an upload can end without a link. */
function failed(title, detail) {
  xhr = null;
  setBusy(false);
  toast(title, detail ? { type: 'error', detail } : {});
  restoreFocus();
}

function upload(file) {
  setBusy(true);
  setProgress(0, file.size);
  $('result').hidden = true;

  const req = new XMLHttpRequest();
  xhr = req;
  req.upload.addEventListener('progress', e =>
    setProgress(e.loaded, e.lengthComputable ? e.total : file.size),
  );
  req.addEventListener('load', () => {
    if (req.status === 401) {
      // The key was reset or deleted since this page loaded.
      xhr = null;
      setBusy(false);
      forgetKey(
        'The server no longer accepts this key. It may have been reset; ask for a new one.',
      );
      return;
    }
    if (req.status < 200 || req.status >= 300) {
      failed('Couldn’t upload.', errorMessage(req.status, req.responseText));
      return;
    }
    let res;
    try {
      res = JSON.parse(req.responseText);
    } catch {
      res = null;
    }
    if (!res?.link || !res?.deletion_link) {
      failed('Couldn’t read the server’s answer.', 'The file may still have been saved.');
      return;
    }
    xhr = null;
    setBusy(false);
    done(file, res);
  });
  req.addEventListener('error', () =>
    failed('Couldn’t upload.', 'The connection failed. Try again.'),
  );
  req.addEventListener('abort', () => failed('Upload canceled.'));

  try {
    req.open('POST', '/upload');
    req.setRequestHeader('Authorization', store.get(KEY_STORAGE) ?? '');
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
    req.setRequestHeader('X-Upload-Filename', name);
    if (file.type) req.setRequestHeader('Content-Type', file.type);
    req.send(file);
    // Focus the progress bar, not Cancel: a second Enter on Upload must not cancel it.
    $('progress-bar').focus();
  } catch (e) {
    failed('Couldn’t start the upload.', e.message);
  }
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
    kind: res.kind ?? 'file',
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

const isWebUrl = v => {
  try {
    return ['http:', 'https:'].includes(new URL(v).protocol);
  } catch {
    return false;
  }
};

/** The list from storage, skipping anything that isn't a well-formed entry. */
function readRecent() {
  const list = store.json(STORAGE.recent, []);
  if (!Array.isArray(list)) return [];
  return list.filter(
    r =>
      r &&
      isWebUrl(r.link) &&
      isWebUrl(r.deletion) &&
      Number.isFinite(r.size) &&
      Number.isFinite(r.at),
  );
}

function addRecent(entry) {
  const list = [entry, ...readRecent()].slice(0, RECENT_MAX);
  store.set(STORAGE.recent, JSON.stringify(list));
  renderRecent();
}

function renderRecent() {
  const list = readRecent();
  recentList.replaceChildren();
  recentList.hidden = list.length === 0;
  $('recent-empty').hidden = list.length > 0;
  $('clear-recent').hidden = list.length === 0;

  for (const r of list) {
    // The stored file name (abc123.png) is what tells rows apart; the origin is the same.
    const id = r.link.split('/').pop();
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
    const link = el('a', '', id);
    link.href = r.link;
    link.target = '_blank';
    link.rel = 'noopener';
    link.title = r.link;
    const detail = [r.name, formatSize(r.size), formatDate(r.at)].filter(Boolean).join(' · ');
    const hint = el('span', 'hint', detail);
    hint.title = detail;
    meta.append(link, hint);

    const tools = el('div', 'row-tools');
    const copyBtn = el('button', 'icon-btn small');
    copyBtn.type = 'button';
    copyBtn.append(icon('copy'));
    setLabel(copyBtn, 'Copy link');
    // Each row's actions say which file they act on.
    copyBtn.setAttribute('aria-label', `Copy link to ${id}`);
    copyBtn.addEventListener('click', () => copy(r.link, copyBtn));

    const del = el('button', 'icon-btn small danger-target');
    del.type = 'button';
    del.append(icon('trash'));
    setLabel(del, 'Delete file');
    del.setAttribute('aria-label', `Delete ${id}`);
    del.addEventListener('click', async () => {
      if (del.getAttribute('aria-disabled') === 'true') return;
      const ok = await confirmAction(del, {
        title: `Delete ${id}?`,
        detail: 'Its link stops working for everyone. This can’t be undone.',
        action: 'Delete file',
      });
      if (!ok) return;
      del.setAttribute('aria-disabled', 'true');
      try {
        await deleteUpload(r);
      } catch (err) {
        del.removeAttribute('aria-disabled');
        toast('Couldn’t delete the file.', { type: 'error', detail: err.message });
        return;
      }
      const rows = [...recentList.children];
      // By id: the list may have re-rendered while the request ran.
      const at = rows.findIndex(x => x.dataset.id === id);
      const nextId = at < 0 ? null : (rows[at + 1] ?? rows[at - 1])?.dataset.id;
      forgetRecent(r);
      toast('File deleted.', { type: 'success' });
      const next =
        nextId && recentList.querySelector(`[data-id="${CSS.escape(nextId)}"] .danger-target`);
      (next || $('recent-title')).focus();
    });

    tools.append(copyBtn, del);
    row.dataset.id = id;
    row.append(thumb, meta, tools);
    recentList.append(row);
  }
}

/** The path of a deletion link: it carries the configured domain, which may not be this one. */
function pathOf(url) {
  try {
    return new URL(url, location.href).pathname;
  } catch {
    return null;
  }
}

/** Deletes an upload with its deletion link. A file that's already gone counts as deleted. */
async function deleteUpload(r) {
  const path = pathOf(r.deletion);
  if (!path?.startsWith('/d/')) throw new Error('This entry has no deletion link.');
  const res = await fetch(path, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) throw new Error(errorMessage(res.status, await res.text()));
}

/** Drops one upload from the recent list. */
function forgetRecent(r) {
  const list = store.json(STORAGE.recent, []);
  if (Array.isArray(list))
    store.set(
      STORAGE.recent,
      JSON.stringify(list.filter(x => pathOf(x?.deletion) !== pathOf(r.deletion))),
    );
  renderRecent();
}

$('clear-recent').addEventListener('click', async e => {
  const ok = await confirmAction(e.currentTarget, {
    title: 'Clear the recent list?',
    detail:
      'Only this list is cleared. The files stay online, but their deletion links go with it.',
    action: 'Clear list',
  });
  if (!ok) return;
  store.set(STORAGE.recent, null);
  renderRecent();
  toast('List cleared.', { detail: 'The files themselves are still online.' });
  // The Clear list button is hidden now; the section heading is always there.
  $('recent-title').focus();
});

// Keep the list in step with deletions made in another tab.
addEventListener('storage', e => e.key === STORAGE.recent && renderRecent());

syncKey();
setMode('file');
// Ask fresh: the key may have been edited, reset or deleted since the last visit.
applyKey({ fresh: true });
renderRecent();
