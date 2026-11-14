import {
  KEY_STORAGE,
  announce,
  confirmAction,
  copy,
  el,
  errorMessage,
  formatDate,
  icon,
  kinds,
  perm,
  setLabel,
  store,
  toast,
  whoami,
} from './ui.js';

const $ = id => document.getElementById(id);
const PERMS = kinds().perms.map(p => p.id);

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

/**
 * A row of permission checkboxes, ending in a "Select all" / "Clear all" switch; returns a
 * getter for the ticked ones.
 */
function permChecks(container, ticked = []) {
  container.replaceChildren();
  const inputs = PERMS.map(id => {
    const label = el('label', 'check');
    const input = el('input');
    input.type = 'checkbox';
    input.value = id;
    input.checked = ticked.includes(id);
    label.append(input, perm(id).label);
    container.append(label);
    return input;
  });
  const all = el('button', 'btn link small check-all');
  all.type = 'button';
  const sync = () => {
    all.textContent = inputs.every(i => i.checked) ? 'Clear all' : 'Select all';
  };
  all.addEventListener('click', () => {
    const on = !inputs.every(i => i.checked);
    for (const i of inputs) i.checked = on;
    sync();
    announce(on ? 'All kinds selected' : 'All kinds cleared');
  });
  container.addEventListener('change', sync);
  container.append(all);
  sync();
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

function hideSecret({ focus = false } = {}) {
  lastSecret = null;
  $('secret-value').value = '';
  $('secret').hidden = true;
  if (focus) $('new-name').focus();
}

$('secret-copy').addEventListener('click', e => copy($('secret-value').value, e.currentTarget));
$('secret-value').addEventListener('focus', e => e.target.select());
$('secret-done').addEventListener('click', () => hideSecret({ focus: true }));

/** Downloads a .sxcu file that ShareX imports with a double-click. */
function downloadSharex(token, key) {
  const config = {
    Version: '17.0.0',
    Name: `uploader · ${key.name}`,
    DestinationType: 'ImageUploader, TextUploader, FileUploader',
    RequestMethod: 'POST',
    RequestURL: `${location.origin}/upload`,
    Headers: { Authorization: token },
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
  const slug = key.name
    .replace(/[^\w-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  a.download = `uploader-${slug || 'key'}.sxcu`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

$('sharex').addEventListener(
  'click',
  () => lastSecret && downloadSharex(lastSecret.token, lastSecret.key),
);

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
  if (!name) {
    toast('Give the key a name.', {
      type: 'error',
      detail: 'Who or what it’s for, so you can find it later.',
    });
    $('new-name').focus();
    return;
  }
  if (perms.length === 0) {
    toast('Pick at least one kind of file.', { type: 'error' });
    document.querySelector('#create-form [data-perms] input')?.focus();
    return;
  }
  const label = button.lastChild;
  button.disabled = true;
  label.textContent = 'Creating…';
  let created;
  try {
    created = await api('POST', '/api/keys', { name, perms });
  } catch (err) {
    toast('Couldn’t create the key.', { type: 'error', detail: err.message });
    return;
  } finally {
    button.disabled = false;
    label.textContent = 'Create key';
  }
  $('new-name').value = '';
  showSecret(created.token, created.key, `Key created for ${created.key.name}`);
  // The key exists either way; a failed refresh is only about the list.
  await reload();
});

// ---------- list ----------

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
  for (const id of PERMS)
    if (key.perms.includes(id)) chips.append(el('span', 'chip', perm(id).label));
  main.append(chips);
  const dates = [`Created ${formatDate(key.created * 1000)}`];
  if (key.reset) dates.push(`reset ${formatDate(key.reset * 1000)}`);
  main.append(el('span', 'hint', dates.join(' · ')));

  const tools = el('div', 'row-tools');
  const show = iconButton(
    'eye',
    'Show key',
    key.viewable ? null : 'Made before keys were kept. Reset it to get one you can show.',
  );
  const edit = iconButton('pencil', 'Edit');
  const reset = iconButton('rotate', 'Reset key', 'Makes a new key. The old one stops working.');
  const del = iconButton('trash', 'Delete key', 'The key stops working. Its uploads stay online.');
  for (const b of [reset, del]) {
    b.classList.add('danger-target');
    b.setAttribute('aria-haspopup', 'dialog');
    b.setAttribute('aria-expanded', 'false');
  }
  if (!key.viewable) {
    // Still pressable, so it can explain itself, but it looks and reads as unavailable.
    show.classList.add('unavailable');
    show.dataset.hint = '';
  }
  // The tooltip stays short; the accessible name says which key.
  show.setAttribute(
    'aria-label',
    key.viewable
      ? `Show the key for ${key.name}`
      : `The key for ${key.name} can’t be shown; reset it to get one that can`,
  );
  if (!key.viewable) {
    const name = show.getAttribute('aria-label');
    setLabel(show, 'Can’t be shown. Reset it first.');
    show.setAttribute('aria-label', name);
  }
  show.setAttribute('aria-expanded', 'false');
  edit.setAttribute('aria-label', `Edit ${key.name}`);
  reset.setAttribute('aria-label', `Reset ${key.name}`);
  del.setAttribute('aria-label', `Delete ${key.name}`);
  tools.append(show, edit, reset, del);
  row.dataset.id = key.id;
  row.append(main, tools);

  const setShown = shown => {
    show.setAttribute('aria-expanded', String(shown));
    setLabel(show, shown ? 'Hide key' : 'Show key');
    show.setAttribute('aria-label', `${shown ? 'Hide' : 'Show'} the key for ${key.name}`);
    show
      .querySelector('use')
      .setAttribute('href', `/static/icons.svg#${shown ? 'eye-off' : 'eye'}`);
  };

  show.addEventListener('click', async () => {
    if (show.getAttribute('aria-disabled') === 'true') return;
    const open = row.querySelector('.key-reveal');
    if (open) {
      open.remove();
      setShown(false);
      return;
    }
    if (!key.viewable) {
      toast('This key can’t be shown.', {
        detail: 'It was made before keys were kept. Reset it to get one you can show again.',
      });
      return;
    }
    show.setAttribute('aria-disabled', 'true');
    let token;
    try {
      ({ token } = await api('GET', `/api/keys/${key.id}/secret`));
    } catch (err) {
      toast('Couldn’t load the key.', { type: 'error', detail: err.message });
      return;
    } finally {
      show.removeAttribute('aria-disabled');
    }
    if (!token || row.querySelector('.key-reveal')) return;
    const panel = el('div', 'key-reveal');
    const fieldRow = el('div', 'field-row');
    // A code block rather than an input, so the whole key wraps into view on phones.
    const field = el('code', 'field key-value', token);
    field.tabIndex = 0;
    field.setAttribute('aria-label', `Key for ${key.name}`);
    const copyBtn = el('button', 'btn secondary small');
    copyBtn.type = 'button';
    copyBtn.append(icon('copy'), 'Copy key');
    copyBtn.addEventListener('click', () => copy(token, copyBtn));
    fieldRow.append(field, copyBtn);
    const sharex = el('button', 'btn ghost small');
    sharex.type = 'button';
    sharex.append(icon('download'), 'Download ShareX config');
    sharex.addEventListener('click', () => downloadSharex(token, key));
    const foot = el('div', 'secret-tools');
    foot.append(sharex);
    panel.append(fieldRow, foot);
    const editForm = row.querySelector('.key-edit');
    if (editForm) editForm.before(panel);
    else row.append(panel);
    setShown(true);
    copyBtn.focus();
  });

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
      } catch (err) {
        save.disabled = false;
        toast('Couldn’t save the key.', { type: 'error', detail: err.message });
        return;
      }
      toast('Key saved.', { type: 'success' });
      await reload({ focusId: key.id, focus: 'edit' });
    });
  });

  /** Asks in a bubble by the button, then runs `action` with the button busy. */
  const confirmed = (button, ask, action) =>
    button.addEventListener('click', async () => {
      if (button.getAttribute('aria-disabled') === 'true') return;
      if (!(await confirmAction(button, ask))) return;
      // aria-disabled keeps focus here while the request runs.
      button.setAttribute('aria-disabled', 'true');
      try {
        await action();
      } finally {
        button.removeAttribute('aria-disabled');
      }
    });

  confirmed(
    reset,
    {
      title: `Reset the key for ${key.name}?`,
      detail: 'It gets a new value. The old one stops working at once, in ShareX too.',
      action: 'Reset key',
    },
    async () => {
      try {
        const { token, key: fresh } = await api('POST', `/api/keys/${key.id}/reset`);
        showSecret(token, fresh, `New key for ${fresh.name}`);
      } catch (err) {
        toast('Couldn’t reset the key.', { type: 'error', detail: err.message });
        return;
      }
      await reload();
    },
  );

  confirmed(
    del,
    {
      title: `Delete the key for ${key.name}?`,
      detail: 'It stops working at once. Files uploaded with it stay online.',
      action: 'Delete key',
    },
    async () => {
      try {
        await api('DELETE', `/api/keys/${key.id}`);
      } catch (err) {
        toast('Couldn’t delete the key.', { type: 'error', detail: err.message });
        return;
      }
      if (lastSecret?.key.id === key.id) hideSecret();
      toast('Key deleted.', { detail: 'Files uploaded with it stay online.' });
      // Focus the next row's delete button (or the previous one, or the name field).
      const rows = [...$('keys-list').children];
      const at = rows.indexOf(row);
      const next = rows[at + 1] ?? rows[at - 1];
      await reload({ focusId: next?.dataset.id, focus: 'delete' });
    },
  );

  return row;
}

async function load() {
  const list = await api('GET', '/api/keys');
  $('keys-loading').hidden = true;
  $('keys-list').hidden = list.length === 0;
  $('keys-empty').hidden = list.length > 0;
  $('keys-count').textContent = list.length ? String(list.length) : '';
  // Newest first. The server lists in creation order, so that breaks ties within a second.
  const order = list.map((k, i) => [k, i]);
  order.sort(([a, i], [b, j]) => b.created - a.created || j - i);
  $('keys-list').replaceChildren(...order.map(([k]) => renderRow(k)));
}

/**
 * Reloads the list after a change and puts focus somewhere that still exists: the given row's
 * button, else the name field. A failed reload only says so; the change itself went through.
 */
async function reload({ focusId, focus } = {}) {
  const hadFocus =
    document.activeElement === document.body || $('keys-list').contains(document.activeElement);
  try {
    await load();
  } catch (err) {
    toast('Couldn’t refresh the list.', { type: 'error', detail: err.message });
  }
  if (!focusId && !hadFocus) return;
  const row = focusId && $('keys-list').querySelector(`[data-id="${CSS.escape(focusId)}"]`);
  const index = { show: 0, edit: 1, delete: 3 }[focus] ?? 1;
  const target = row?.querySelectorAll('.row-tools button')[index];
  (target ?? $('new-name')).focus();
}

// ---------- start ----------

// Show the form and the loading row at once; the key check and the list load side by side.
$('admin').hidden = false;
const listed = load().catch(err => err);
const who = await whoami({ fresh: true });
if (who?.admin) {
  const err = await listed;
  if (err instanceof Error) {
    $('keys-loading').hidden = true;
    toast('Couldn’t load the keys.', { type: 'error', detail: err.message });
  }
} else {
  $('admin').hidden = true;
  $('not-admin').hidden = false;
  if (who && !who.invalid)
    $('not-admin-text').textContent =
      'Your key can upload, but only the admin key can manage keys.';
}
