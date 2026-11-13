// Shared UI for every cyex uploader page: theme toggle, tooltips, toasts, copy, formats.

const ICONS = '/static/icons.svg';

/** A sprite icon as an SVG element. */
export function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'i');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `${ICONS}#${name}`);
  svg.append(use);
  return svg;
}

/** `document.createElement` with a class and text in one go. */
export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** localStorage that never throws (private windows, blocked storage). */
export const store = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      if (value == null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      /* storage unavailable: the setting just isn't remembered */
    }
  },
  json(key, fallback) {
    try {
      return JSON.parse(this.get(key)) ?? fallback;
    } catch {
      return fallback;
    }
  },
};

// ---------- cyex formats ----------

/** `40.000` */
export function groupThousands(n) {
  return Math.trunc(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/** `999 B`, `1,5 KB`, `12,3 MB`, `150 MB`; rounded down. Matches the server's format. */
export function formatSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  if (bytes < 1024) return `${groupThousands(bytes)} B`;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const text =
    value >= 100
      ? String(Math.floor(value))
      : String(Math.floor(value * 10) / 10).replace('.', ',');
  return `${text} ${units[unit]}`;
}

/** `0:07`, `12:30`, `1:02:03` */
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const s = Math.floor(seconds % 60);
  const m = Math.floor(seconds / 60) % 60;
  const h = Math.floor(seconds / 3600);
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** `2026/11/13` in local time. */
export function formatDate(time) {
  const d = new Date(time);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
}

/** `1,5` with a comma decimal, at most `digits` places, trailing zeros dropped. */
export function formatDecimal(n, digits = 2) {
  return String(Number(n.toFixed(digits))).replace('.', ',');
}

// ---------- toasts ----------

const LIFETIME = { info: 3500, success: 3500, error: 9000 };

/**
 * @param {string} title short lead, e.g. "Link copied." or "Couldn’t upload."
 * @param {{type?: 'info' | 'success' | 'error', detail?: string}} [opts]
 */
export function toast(title, { type = 'info', detail } = {}) {
  const stack = document.querySelector(type === 'error' ? '.toasts.errors' : '.toasts.notices');
  if (!stack) return;

  // A repeat bumps a count instead of stacking.
  for (const existing of stack.children) {
    if (existing.dataset.key === title + (detail ?? '')) {
      const n = Number(existing.dataset.count ?? 1) + 1;
      existing.dataset.count = String(n);
      existing.querySelector('strong').textContent = `${title} ×${n}`;
      existing.restart?.();
      return;
    }
  }

  const node = el('div', `toast ${type}`);
  node.dataset.key = title + (detail ?? '');
  // The error stack is already an assertive live region; role=alert too would read it twice.
  node.append(el('strong', '', title));
  if (detail) node.append(el('div', 'detail', detail));
  const close = el('button', 'close');
  close.type = 'button';
  close.setAttribute('aria-label', 'Dismiss');
  close.append(icon('x'));
  node.append(close);
  const drain = el('div', 'drain');
  node.append(drain);

  let timer;
  let remaining = LIFETIME[type];
  let started;
  const dismiss = () => {
    clearTimeout(timer);
    if (reducedMotion()) return node.remove();
    node.classList.add('leaving');
    node.addEventListener('transitionend', () => node.remove(), { once: true });
    setTimeout(() => node.remove(), 400);
  };
  const run = () => {
    started = performance.now();
    timer = setTimeout(dismiss, remaining);
  };
  const hold = () => {
    clearTimeout(timer);
    remaining -= performance.now() - started;
  };
  node.restart = () => {
    clearTimeout(timer);
    remaining = LIFETIME[type];
    drain.style.animation = 'none';
    void drain.offsetWidth;
    drain.style.animation = '';
    drain.style.animationDuration = `${remaining}ms`;
    run();
  };
  drain.style.animationDuration = `${remaining}ms`;
  close.addEventListener('click', dismiss);
  node.addEventListener('mouseenter', hold);
  node.addEventListener('mouseleave', run);
  node.addEventListener('focusin', hold);
  node.addEventListener('focusout', run);

  stack.append(node);
  while (stack.children.length > 3) stack.firstElementChild.remove();
  run();
}

/** Reads `{error}` (actix-web-error) or plain text out of a failed response body. */
export function errorMessage(status, body) {
  try {
    const json = JSON.parse(body);
    if (json?.error) return json.error;
    if (json?.message) return json.message;
  } catch {
    /* not JSON */
  }
  return body?.trim() || `The server answered ${status}.`;
}

// ---------- copy ----------

async function writeClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      /* permission denied or no focus: try the old way */
    }
  }
  // Plain-HTTP (and denied-permission) fallback.
  const area = el('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.className = 'sr-only';
  document.body.append(area);
  area.select();
  const ok = document.execCommand('copy');
  area.remove();
  if (!ok) throw new Error('copy refused');
}

/**
 * Copies `text`; a button gets a short "Copied" state with a check, no toast needed.
 * @param {string} text
 * @param {HTMLElement} [button]
 */
export async function copy(text, button) {
  try {
    await writeClipboard(text);
  } catch {
    toast('Couldn’t copy.', {
      type: 'error',
      detail: 'Your browser blocked the clipboard. Copy it by hand.',
    });
    return false;
  }
  if (button) {
    if (!button.dataset.label) button.dataset.label = button.textContent.trim();
    const svg = button.querySelector('svg');
    const label = [...button.childNodes].find(
      n => n.nodeType === Node.TEXT_NODE && n.textContent.trim(),
    );
    clearTimeout(button._copiedTimer);
    if (label) label.textContent = 'Copied';
    svg?.querySelector('use')?.setAttribute('href', `${ICONS}#check`);
    if (!label) toast('Copied.', { type: 'success' });
    button._copiedTimer = setTimeout(() => {
      if (label) label.textContent = button.dataset.label.replace(/^\s+/, '');
      svg?.querySelector('use')?.setAttribute('href', `${ICONS}#${button.dataset.icon ?? 'copy'}`);
    }, 1600);
  } else {
    toast('Copied.', { type: 'success' });
  }
  return true;
}

// ---------- tooltips ----------

let tip = null;
let tipTimer = 0;
let lastHidden = 0;

function showTip(target) {
  hideTip();
  const label = target.dataset.tip;
  if (!label) return;
  tip = el('div', 'tooltip', label);
  tip.setAttribute('role', 'tooltip');
  if (target.dataset.hint && store.get('cyexHints') !== 'off') {
    tip.append(el('span', 'tip-hint', target.dataset.hint));
  }
  document.body.append(tip);
  const r = target.getBoundingClientRect();
  const t = tip.getBoundingClientRect();
  let top = r.bottom + 6;
  if (top + t.height > innerHeight - 8) top = r.top - t.height - 6; // flip above
  const left = Math.min(Math.max(8, r.left + r.width / 2 - t.width / 2), innerWidth - t.width - 8);
  tip.style.top = `${top}px`;
  tip.style.left = `${left}px`;
}

function hideTip() {
  clearTimeout(tipTimer);
  if (tip) {
    tip.remove();
    tip = null;
    lastHidden = performance.now();
  }
}

function initTooltips() {
  const schedule = e => {
    const target = e.target.closest?.('[data-tip]');
    if (!target) return;
    clearTimeout(tipTimer);
    // Once one has shown, the next within 400 ms is instant.
    const delay = performance.now() - lastHidden < 400 ? 0 : 150;
    tipTimer = setTimeout(() => showTip(target), delay);
  };
  const leave = e => {
    if (e.target.closest?.('[data-tip]')) hideTip();
  };
  document.addEventListener('pointerover', e => e.pointerType === 'mouse' && schedule(e));
  document.addEventListener('pointerout', leave);
  document.addEventListener('focusin', e => e.target.matches?.(':focus-visible') && schedule(e));
  document.addEventListener('focusout', leave);
  document.addEventListener('pointerdown', hideTip, true);
  addEventListener('scroll', hideTip, true);
  addEventListener('resize', hideTip);
  document.addEventListener('keydown', e => e.key === 'Escape' && hideTip());
}

/** Keeps a button's tooltip and aria-label in sync. */
export function setLabel(button, label) {
  button.setAttribute('aria-label', label);
  button.dataset.tip = label;
  if (tip) hideTip();
}

// ---------- theme ----------

function initTheme() {
  const button = document.getElementById('theme-toggle');
  if (!button) return;
  const root = document.documentElement;
  const meta = document.querySelector('meta[name="theme-color"]');
  const sync = () => {
    const light = root.dataset.theme === 'light';
    button.querySelector('.theme-dark-icon').hidden = light;
    button.querySelector('.theme-light-icon').hidden = !light;
    setLabel(button, light ? 'Switch to dark theme' : 'Switch to light theme');
    if (meta) meta.content = light ? '#f3f3f4' : '#1e1f23';
  };
  const apply = () => {
    const light = root.dataset.theme !== 'light';
    if (light) root.dataset.theme = 'light';
    else delete root.dataset.theme;
    store.set('cyexTheme', light ? 'light' : null);
    sync();
  };
  button.addEventListener('click', () => {
    if (document.startViewTransition && !reducedMotion()) document.startViewTransition(apply);
    else apply();
  });
  sync();
}

initTheme();
initTooltips();

// ---------- upload key ----------

// Same storage name as upstream, so a key saved before the fork keeps working.
export const KEY_STORAGE = 'uploader-authorization';

export const PERM_LABELS = {
  image: 'Pictures',
  gif: 'GIFs',
  video: 'Video',
  audio: 'Audio',
  text: 'Text',
  file: 'Other files',
};

/** Plural nouns for sentences, matching the server's messages. */
export const PERM_NOUNS = {
  image: 'pictures',
  gif: 'GIFs',
  video: 'videos',
  audio: 'audio',
  text: 'text',
  file: 'other files',
};

/** "pictures", "pictures and GIFs", "pictures, GIFs and videos" */
export function describePerms(perms) {
  const words = Object.keys(PERM_NOUNS)
    .filter(p => perms.includes(p))
    .map(p => PERM_NOUNS[p]);
  return words.length < 2
    ? (words[0] ?? 'nothing')
    : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

/**
 * What the saved key may do: `{admin, name, perms}`, `null` without a key, or `{invalid: true}`
 * when the server refuses it. Cached for the tab so viewers don't ask on every page.
 */
export async function whoami({ fresh = false } = {}) {
  const key = store.get(KEY_STORAGE);
  if (!key) return null;
  if (!fresh) {
    try {
      const cached = JSON.parse(sessionStorage.getItem('cyexUploaderWho'));
      if (cached?.key === key) return cached.who;
    } catch {
      /* no cache */
    }
  }
  try {
    const res = await fetch('/api/key', { headers: { Authorization: key } });
    const who = res.ok ? await res.json() : res.status === 401 ? { invalid: true } : null;
    if (who) {
      try {
        sessionStorage.setItem('cyexUploaderWho', JSON.stringify({ key, who }));
      } catch {
        /* storage unavailable */
      }
    }
    return who;
  } catch {
    return null; // offline: don't guess
  }
}

export function forgetWho() {
  try {
    sessionStorage.removeItem('cyexUploaderWho');
  } catch {
    /* storage unavailable */
  }
}

// The Keys link only shows for the admin.
whoami().then(who => {
  const link = document.getElementById('nav-keys');
  if (link) link.hidden = !who?.admin;
});
