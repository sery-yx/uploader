import { STORAGE, errorMessage, store, toast } from './ui.js';

const button = document.getElementById('confirm-delete');

button?.addEventListener('click', async () => {
  button.disabled = true;
  const label = button.lastChild;
  label.textContent = 'Deleting…';
  try {
    const res = await fetch(location.pathname, { method: 'DELETE' });
    if (!res.ok && res.status !== 404) {
      throw new Error(errorMessage(res.status, await res.text()));
    }
    // Forget it in the uploader's recent list too. Compare paths: the stored link carries the
    // configured domain, which needn't match the address this page was opened on.
    const pathOf = url => {
      try {
        return new URL(url, location.href).pathname;
      } catch {
        return null;
      }
    };
    const list = store.json(STORAGE.recent, []);
    if (Array.isArray(list)) {
      store.set(
        STORAGE.recent,
        JSON.stringify(list.filter(r => pathOf(r?.deletion) !== location.pathname)),
      );
    }
    for (const node of document.querySelectorAll('[data-step]'))
      node.hidden = node.dataset.step !== 'done';
    document.getElementById('deleted').focus();
  } catch (e) {
    button.disabled = false;
    label.textContent = 'Delete file';
    toast('Couldn’t delete the file.', { type: 'error', detail: e.message });
  }
});
