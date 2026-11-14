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
  let held = false;
  const dismiss = () => {
    clearTimeout(timer);
    if (node.classList.contains('leaving')) return;
    if (reducedMotion()) return node.remove();
    node.classList.add('leaving');
    node.addEventListener('transitionend', () => node.remove(), { once: true });
    setTimeout(() => node.remove(), 400);
  };
  const run = () => {
    held = false;
    started = performance.now();
    timer = setTimeout(dismiss, Math.max(0, remaining));
  };
  // Hover and focus both hold the toast; count the time only once.
  const hold = () => {
    if (held) return;
    held = true;
    clearTimeout(timer);
    remaining -= performance.now() - started;
  };
  const release = () => {
    if (!node.matches(':hover') && !node.contains(document.activeElement)) run();
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
  node.addEventListener('mouseleave', release);
  node.addEventListener('focusin', hold);
  node.addEventListener('focusout', () => setTimeout(release));
  node.dismiss = dismiss;

  stack.append(node);
  // At most three; the oldest leaves the normal way.
  const live = [...stack.children].filter(t => !t.classList.contains('leaving'));
  for (const old of live.slice(0, Math.max(0, live.length - 3))) old.dismiss?.();
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
  // A proxy's HTML error page or a long body is noise in a toast.
  const text = body?.trim() ?? '';
  return text && text.length <= 140 && !text.includes('<')
    ? text
    : `The server answered ${status}.`;
}

// ---------- announcements ----------

let announcer = null;

/** Reads `text` to screen readers without showing anything. */
export function announce(text) {
  if (!announcer) {
    announcer = el('div', 'sr-only');
    announcer.setAttribute('role', 'status');
    announcer.setAttribute('aria-live', 'polite');
    document.body.append(announcer);
  }
  // Clear first so the same words twice in a row are read twice.
  announcer.textContent = '';
  setTimeout(() => (announcer.textContent = text), 50);
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
    // Hold the width so "Copied" doesn't nudge the field next to it.
    button.style.minWidth = `${button.getBoundingClientRect().width}px`;
    if (label) label.textContent = 'Copied';
    svg?.querySelector('use')?.setAttribute('href', `${ICONS}#check`);
    if (label) announce('Copied');
    else toast('Copied.', { type: 'success' });
    button._copiedTimer = setTimeout(() => {
      if (label) label.textContent = button.dataset.label.replace(/^\s+/, '');
      svg?.querySelector('use')?.setAttribute('href', `${ICONS}#${button.dataset.icon ?? 'copy'}`);
      button.style.minWidth = '';
    }, 1600);
  } else {
    toast('Copied.', { type: 'success' });
  }
  return true;
}

// ---------- tooltips ----------

let tip = null;
let tipFor = null; // the element the tooltip shows (or is about to show) for
let tipTimer = 0;
let tipMuted = null; // pressed: no tooltip again until the pointer leaves it
let lastHidden = -Infinity; // no tooltip yet, so the first one waits

function showTip(target) {
  hideTip();
  tipFor = target;
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
  tipFor = null;
  if (tip) {
    tip.remove();
    tip = null;
    lastHidden = performance.now();
  }
}

function initTooltips() {
  const schedule = e => {
    const target = e.target.closest?.('[data-tip]');
    // Moving between a button's own parts (its icon, its label) isn't a new hover.
    if (!target || target === tipFor || target === tipMuted) return;
    clearTimeout(tipTimer);
    tipFor = target;
    // Once one has shown, the next within 400 ms is instant.
    const delay = performance.now() - lastHidden < 400 ? 0 : 150;
    tipTimer = setTimeout(() => showTip(target), delay);
  };
  const leave = e => {
    const target = e.target.closest?.('[data-tip]');
    // Only leaving the element itself hides it, not moving onto one of its children.
    if (target && !target.contains(e.relatedTarget)) {
      // Only the pointer leaving lifts the mute; focus moving away (into a form it opened)
      // doesn't mean the pointer left.
      if (target === tipMuted && e.type === 'pointerout') tipMuted = null;
      hideTip();
    }
  };
  document.addEventListener('pointerover', e => e.pointerType === 'mouse' && schedule(e));
  document.addEventListener('pointerout', leave);
  document.addEventListener('focusin', e => {
    if (!e.target.matches?.(':focus-visible')) return;
    // Keyboard focus on the pressed element itself gets its tooltip again.
    if (e.target.closest?.('[data-tip]') === tipMuted) tipMuted = null;
    schedule(e);
  });
  document.addEventListener('focusout', leave);
  document.addEventListener(
    'pointerdown',
    e => {
      tipMuted = e.target.closest?.('[data-tip]') ?? null;
      hideTip();
    },
    true,
  );
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

// ---------- confirmation bubble ----------

let openConfirm = null;

/**
 * A small popover by `anchor` that asks before something destructive: a title, an optional
 * line of detail, Cancel and the action. It floats, so nothing around it moves. Resolves true
 * when the action is picked; Escape, Cancel, an outside click or opening another one resolve
 * false. Focus goes back to the anchor either way.
 */
export function confirmAction(anchor, { title, detail, action, danger = true }) {
  if (openConfirm?.anchor === anchor) {
    openConfirm.close(false);
    return Promise.resolve(false);
  }
  openConfirm?.close(false, { refocus: false });
  hideTip();

  return new Promise(resolve => {
    const id = `confirm-${Math.random().toString(36).slice(2, 8)}`;
    const pop = el('div', 'popover confirm');
    pop.setAttribute('role', 'alertdialog');
    pop.setAttribute('aria-labelledby', `${id}-title`);
    pop.tabIndex = -1;
    const heading = el('p', 'confirm-title', title);
    heading.id = `${id}-title`;
    pop.append(heading);
    if (detail) {
      const p = el('p', 'confirm-detail', detail);
      p.id = `${id}-detail`;
      pop.setAttribute('aria-describedby', p.id);
      pop.append(p);
    }
    const actions = el('div', 'confirm-actions');
    const cancel = el('button', 'btn secondary small', 'Cancel');
    cancel.type = 'button';
    const go = el('button', `btn ${danger ? 'danger' : 'primary'} small`, action);
    go.type = 'button';
    actions.append(cancel, go);
    pop.append(actions);
    document.body.append(pop);

    const place = () => {
      // The list re-rendered under it: the button it belongs to is gone.
      if (!anchor.isConnected) return close(false, { refocus: false });
      const r = anchor.getBoundingClientRect();
      // Scrolled out of sight: close rather than float on with focus inside it.
      if (r.bottom < 0 || r.top > innerHeight) return close(false, { scroll: false });
      const p = pop.getBoundingClientRect();
      // Aligned to the anchor's end, 6px below; above when there isn't room. Never over it.
      let top = r.bottom + 6;
      if (top + p.height > innerHeight - 8 && r.top - p.height - 6 >= 8) top = r.top - p.height - 6;
      const left = Math.min(Math.max(8, r.right - p.width), innerWidth - p.width - 8);
      pop.style.top = `${top}px`;
      pop.style.left = `${left}px`;
      pop.dataset.side = top < r.top ? 'above' : 'below';
    };

    const outside = e => {
      if (!pop.contains(e.target) && !anchor.contains(e.target)) close(false, { refocus: false });
    };
    const keys = e => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close(false);
      } else if (e.key === 'Tab') {
        // Keep Tab inside the two buttons while it's open.
        const first = cancel;
        const last = go;
        if (e.shiftKey && document.activeElement === first) (e.preventDefault(), last.focus());
        else if (!e.shiftKey && document.activeElement === last)
          (e.preventDefault(), first.focus());
        else if (document.activeElement === pop)
          (e.preventDefault(), (e.shiftKey ? last : first).focus());
      }
    };
    function close(result, { refocus = true, scroll = true } = {}) {
      if (openConfirm?.pop !== pop) return;
      openConfirm = null;
      document.removeEventListener('pointerdown', outside, true);
      removeEventListener('resize', place);
      removeEventListener('scroll', place, true);
      anchor.setAttribute('aria-expanded', 'false');
      pop.remove();
      if (refocus && anchor.isConnected) anchor.focus({ preventScroll: !scroll });
      // Picking the action for a button that's no longer on the page does nothing.
      resolve(result && anchor.isConnected);
    }
    openConfirm = { anchor, pop, close };
    place();
    anchor.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', outside, true);
    addEventListener('resize', place);
    addEventListener('scroll', place, true);
    pop.addEventListener('keydown', keys);
    cancel.addEventListener('click', () => close(false));
    go.addEventListener('click', () => close(true));
    // Keyboard users land on Cancel; a mouse press puts focus on the panel without a ring.
    (anchor.matches(':focus-visible') ? cancel : pop).focus();
  });
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
    if (!document.startViewTransition || reducedMotion()) return apply();
    // Colours swap at once inside the cross-fade instead of animating underneath it.
    root.classList.add('theme-switching');
    const t = document.startViewTransition(apply);
    t.finished.finally(() => root.classList.remove('theme-switching'));
  });
  sync();
}

initTheme();
initTooltips();

// ---------- upload key ----------

/** Every browser-storage name the pages use. The key's name is upstream's, so old keys work. */
export const STORAGE = {
  key: 'uploader-authorization',
  recent: 'cyexUploaderRecent',
  volume: 'cyexUploaderVolume',
  muted: 'cyexUploaderMuted',
  wrap: 'cyexUploaderWrap',
  highlight: 'cyexUploaderHighlight',
  who: 'cyexUploaderWho',
};
export const KEY_STORAGE = STORAGE.key;

let kindTable = null;

/**
 * The server's permission table, rendered into the page (`data-kinds`) so the browser classifies
 * files exactly like the server does: `{perms: [{id, label, one, noun}], exts: {ext: id}}`.
 */
export function kinds() {
  if (!kindTable) {
    try {
      kindTable = JSON.parse(document.querySelector('[data-kinds]')?.dataset.kinds ?? '');
    } catch {
      kindTable = null;
    }
    kindTable ??= { perms: [], exts: {} };
  }
  return kindTable;
}

/** `{id, label, one, noun}` for a permission id like `gif`. */
export const perm = id => kinds().perms.find(p => p.id === id);

/** "pictures", "pictures and GIFs", "pictures, GIFs and videos", in the server's order. */
export function describePerms(ids) {
  const words = kinds()
    .perms.filter(p => ids.includes(p.id))
    .map(p => p.noun);
  return words.length < 2
    ? (words[0] ?? 'nothing')
    : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

/**
 * The permission a file needs. The extension decides, as on the server (browsers leave mkv,
 * flac, opus and most code untyped); an unknown or missing extension falls back to the type.
 */
export function permOfFile(file) {
  const dot = file.name.lastIndexOf('.');
  const ext = dot > 0 ? file.name.slice(dot + 1).toLowerCase() : '';
  const known = kinds().exts[ext];
  if (known) return known;
  if (file.type === 'image/gif') return 'gif';
  const top = file.type.split('/')[0];
  return ['image', 'video', 'audio', 'text'].includes(top) ? top : 'file';
}

/**
 * What the saved key may do: `{admin, name, perms}`, `null` without a key, or `{invalid: true}`
 * when the server refuses it. Cached for the tab so viewers don't ask on every page.
 */
const WHO_TTL = 60_000; // a reset or deleted key shows up within a minute on other pages
let whoInFlight = null;

export async function whoami({ fresh = false } = {}) {
  const key = store.get(KEY_STORAGE);
  if (!key) return null;
  if (!fresh) {
    try {
      const cached = JSON.parse(sessionStorage.getItem(STORAGE.who));
      if (cached?.key === key && Date.now() - cached.at < WHO_TTL) return cached.who;
    } catch {
      /* no cache */
    }
  }
  // The page and its header both ask on load; share one request.
  if (whoInFlight?.key === key) return whoInFlight.promise;
  const promise = (async () => {
    try {
      const res = await fetch('/api/key', { headers: { Authorization: key } });
      const who = res.ok ? await res.json() : res.status === 401 ? { invalid: true } : null;
      if (who) {
        try {
          sessionStorage.setItem(STORAGE.who, JSON.stringify({ key, who, at: Date.now() }));
        } catch {
          /* storage unavailable */
        }
      }
      return who;
    } catch {
      return null; // offline: don't guess
    } finally {
      whoInFlight = null;
    }
  })();
  whoInFlight = { key, promise };
  return promise;
}

export function forgetWho() {
  try {
    sessionStorage.removeItem(STORAGE.who);
  } catch {
    /* storage unavailable */
  }
}

/** The Keys link only shows for the admin. */
export function syncNav(who) {
  const link = document.getElementById('nav-keys');
  if (link) link.hidden = !who?.admin;
}
whoami().then(syncNav);
