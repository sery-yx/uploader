import {
  KEY_STORAGE,
  PERM_LABELS,
  copy,
  el,
  errorMessage,
  formatDate,
  icon,
  setLabel,
  store,
  toast,
  whoami,
} from './ui.js';

const $ = id => document.getElementById(id);
const PERMS = Object.keys(PERM_LABELS);

/** Calls the key API with the saved admin key; throws an Error with the server's message. */
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: {
      Authorization: store.get(KEY_STORAGE) ?? '',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(errorMessage(res.status, await res.text()));
  return res.status === 204 ? null : res.json();
}

/** A row of permission checkboxes; returns a getter for the ticked ones. */
function permChecks(container, ticked = []) {
  container.replaceChildren();
  const inputs = PERMS.map(perm => {
    const label = el('label', 'check');
    const input = el('input');
    input.type = 'checkbox';
    input.value = perm;
    input.checked = ticked.includes(perm);
    label.append(input, PERM_LABELS[perm]);
    container.append(label);
    return input;
  });
  return () => inputs.filter(i => i.checked).map(i => i.value);
}

// ---------- the one-time secret ----------

let lastSecret = null;

function showSecret(token, key, heading) {
  lastSecret = { token, key };
  $('secret-heading').textContent = heading;
  $('secret-value').value = token;
  $('secret').hidden = false;
  $('secret').focus();
}

function hideSecret() {
  lastSecret = null;
  $('secret-value').value = '';
  $('secret').hidden = true;
}

$('secret-copy').addEventListener('click', e => copy($('secret-value').value, e.currentTarget));
$('secret-value').addEventListener('focus', e => e.target.select());
$('secret-done').addEventListener('click', hideSecret);

// A .sxcu file ShareX imports with a double-click.
$('sharex').addEventListener('click', () => {
  if (!lastSecret) return;
  const config = {
    Version: '17.0.0',
    Name: `uploader · ${lastSecret.key.name}`,
    DestinationType: 'ImageUploader, TextUploader, FileUploader',
    RequestMethod: 'POST',
    RequestURL: `${location.origin}/upload`,
    Headers: { Authorization: lastSecret.token },
    Body: 'MultipartFormData',
    FileFormName: 'file',
    URL: '{json:link}',
    DeletionURL: '{json:deletion_link}',
    ErrorMessage: '{json:error}',
  };
  const a = el('a');
  a.href = URL.createObjectURL(
    new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' }),
  );
  a.download = `uploader-${lastSecret.key.name.replace(/[^\w-]+/g, '-').toLowerCase() || 'key'}.sxcu`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

// ---------- create ----------

const getNewPerms = permChecks(document.querySelector('#create-form [data-perms]'), [
  'image',
  'gif',
]);

$('create-form').addEventListener('submit', async e => {
  e.preventDefault();
  const button = e.submitter ?? $('create-form').querySelector('[type=submit]');
  const name = $('new-name').value.trim();
  const perms = getNewPerms();
  if (!name) return $('new-name').focus();
  if (perms.length === 0) {
    toast('Pick at least one kind of file.', { type: 'error' });
    return;
  }
  button.disabled = true;
  try {
    const { token, key } = await api('POST', '/api/keys', { name, perms });
    $('new-name').value = '';
    showSecret(token, key, `Key created for ${key.name}`);
    await load();
  } catch (err) {
    toast('Couldn’t create the key.', { type: 'error', detail: err.message });
  } finally {
    button.disabled = false;
  }
});

// ---------- list ----------

/**
 * Destructive buttons arm on the first press ("Click again to …") and act on a second press
 * within 3 s.
 */
function armed(button, note, row, action) {
  let timer = 0;
  let noteEl = null;
  const disarm = () => {
    clearTimeout(timer);
    button.classList.remove('armed');
    noteEl?.remove();
    noteEl = null;
  };
  button.addEventListener('click', async () => {
    if (!button.classList.contains('armed')) {
      button.classList.add('armed');
      noteEl = el('span', 'armed-note', note);
      noteEl.setAttribute('role', 'status');
      row.append(noteEl);
      timer = setTimeout(disarm, 3000);
      return;
    }
    disarm();
    button.disabled = true;
    try {
      await action();
    } finally {
      button.disabled = false;
    }
  });
  button.addEventListener('blur', disarm);
}

function iconButton(name, label, hint) {
  const b = el('button', 'icon-btn small');
  b.type = 'button';
  b.append(icon(name));
  setLabel(b, label);
  if (hint) b.dataset.hint = hint;
  return b;
}

function renderRow(key) {
  const row = el('li', 'row key-row');
  const main = el('div', 'key-main');
  main.append(el('span', 'key-name', key.name));
  const chips = el('div', 'chips');
  for (const perm of PERMS)
    if (key.perms.includes(perm)) chips.append(el('span', 'chip', PERM_LABELS[perm]));
  main.append(chips);
  const dates = [`Created ${formatDate(key.created * 1000)}`];
  if (key.reset) dates.push(`reset ${formatDate(key.reset * 1000)}`);
  main.append(el('span', 'hint', dates.join(' · ')));

  const tools = el('div', 'row-tools');
  const edit = iconButton('pencil', 'Edit');
  const reset = iconButton('rotate', 'Reset key', 'Makes a new key. The old one stops working.');
  const del = iconButton('trash', 'Delete key', 'The key stops working. Its uploads stay online.');
  tools.append(edit, reset, del);
  row.append(main, tools);

  edit.addEventListener('click', () => {
    if (row.querySelector('.key-edit')) return;
    const form = el('form', 'key-edit');
    const nameLabel = el('label', 'label field-label', 'Name');
    const nameInput = el('input', 'field');
    nameInput.value = key.name;
    nameInput.maxLength = 60;
    nameInput.required = true;
    nameInput.id = `name-${key.id}`;
    nameLabel.htmlFor = nameInput.id;
    const checks = el('div', 'checks');
    checks.setAttribute('role', 'group');
    checks.setAttribute('aria-label', 'Can upload');
    const getPerms = permChecks(checks, key.perms);
    const actions = el('div', 'actions');
    const cancel = el('button', 'btn secondary small', 'Cancel');
    cancel.type = 'button';
    const save = el('button', 'btn primary small', 'Save');
    save.type = 'submit';
    actions.append(cancel, save);
    const nameWrap = el('div');
    nameWrap.append(nameLabel, nameInput);
    form.append(nameWrap, checks, actions);
    row.append(form);
    nameInput.focus();

    const close = () => {
      form.remove();
      edit.focus();
    };
    cancel.addEventListener('click', close);
    form.addEventListener('keydown', e => e.key === 'Escape' && close());
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const perms = getPerms();
      if (perms.length === 0) {
        toast('Pick at least one kind of file.', { type: 'error' });
        return;
      }
      save.disabled = true;
      try {
        await api('PUT', `/api/keys/${key.id}`, { name: nameInput.value.trim(), perms });
        toast('Key saved.', { type: 'success' });
        await load();
      } catch (err) {
        save.disabled = false;
        toast('Couldn’t save the key.', { type: 'error', detail: err.message });
      }
    });
  });

  armed(reset, 'Click again to reset. The old key stops working.', row, async () => {
    try {
      const { token, key: fresh } = await api('POST', `/api/keys/${key.id}/reset`);
      showSecret(token, fresh, `New key for ${fresh.name}`);
      await load();
    } catch (err) {
      toast('Couldn’t reset the key.', { type: 'error', detail: err.message });
    }
  });

  armed(del, 'Click again to delete.', row, async () => {
    try {
      await api('DELETE', `/api/keys/${key.id}`);
      if (lastSecret?.key.id === key.id) hideSecret();
      toast('Key deleted.', { detail: 'Files uploaded with it stay online.' });
      await load();
    } catch (err) {
      toast('Couldn’t delete the key.', { type: 'error', detail: err.message });
    }
  });

  return row;
}

async function load() {
  const list = await api('GET', '/api/keys');
  $('keys-loading').hidden = true;
  $('keys-list').hidden = list.length === 0;
  $('keys-empty').hidden = list.length > 0;
  $('keys-count').textContent = list.length ? String(list.length) : '';
  // Newest first.
  list.sort((a, b) => b.created - a.created);
  $('keys-list').replaceChildren(...list.map(renderRow));
}

// ---------- start ----------

const who = await whoami({ fresh: true });
if (who?.admin) {
  $('admin').hidden = false;
  load().catch(err => {
    $('keys-loading').hidden = true;
    toast('Couldn’t load the keys.', { type: 'error', detail: err.message });
  });
} else {
  $('not-admin').hidden = false;
  if (who && !who.invalid)
    $('not-admin-text').textContent =
      'Your key can upload, but only the admin key can manage keys.';
}
