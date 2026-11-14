import {
  STORAGE,
  copy,
  formatDecimal,
  formatDuration,
  formatSize,
  groupThousands,
  setLabel,
  store,
  toast,
} from './ui.js';

const view = document.getElementById('view');
const { kind, raw, name, ext } = view.dataset;
const bytes = Number(view.dataset.bytes);
const extra = document.getElementById('extra-meta');

/** Shows the `[data-show]` part of a button that matches `state` and hides the others. */
function showPart(button, state) {
  for (const part of button.querySelectorAll('[data-show]'))
    part.hidden = part.dataset.show !== state;
}

function addMeta(text) {
  if (!text) return;
  extra.textContent = extra.textContent ? `${extra.textContent} · ${text}` : `· ${text}`;
}

document.getElementById('copy-link').addEventListener('click', e => {
  copy(`${location.origin}/${name}`, e.currentTarget);
});
document.getElementById('copy-link').dataset.icon = 'link';

// ---------- picture / GIF ----------

function initImage() {
  const stage = document.getElementById('stage');
  const img = document.getElementById('media');
  const hint = document.getElementById('image-hint');

  const ready = () => {
    const { naturalWidth: w, naturalHeight: h } = img;
    addMeta(`${groupThousands(w)} × ${groupThousands(h)}`);
    const pixel = w <= 128 && h <= 128;
    const MAX = 16;

    /** Real size, or smaller when the picture is larger than the window. */
    const base = () => Math.min(1, stage.clientWidth / w, Math.max(160, innerHeight - 230) / h);
    let scale = base();
    let zoomed = false; // changed by the user; a resize keeps it

    const syncHint = () => {
      const pct = `${groupThousands(Math.round(scale * 100))} %`;
      const touch = matchMedia('(hover: none)').matches;
      hint.textContent = zoomed
        ? `${pct} · ${touch ? 'Tap to zoom out, swipe' : 'Click to zoom out, drag'} to move around.`
        : `${pct} · ${touch ? 'Tap' : 'Scroll or click'} to zoom in.`;
      stage.setAttribute('aria-label', `Picture at ${pct}. Plus and minus zoom, 0 resets.`);
    };

    /**
     * Zooms to `next`, keeping the point (`x`, `y`, relative to the stage's box) where it is on
     * screen. Without a point it keeps the middle.
     */
    const zoomTo = (next, x = stage.clientWidth / 2, y = stage.clientHeight / 2) => {
      const b = base();
      next = Math.min(Math.max(next, b), Math.max(MAX, b));
      const box = stage.getBoundingClientRect();
      const before = img.getBoundingClientRect();
      // That point in the picture's own pixels.
      const px = (box.left + x - before.left) / scale;
      const py = (box.top + y - before.top) / scale;
      scale = next;
      zoomed = Math.abs(scale - b) > 0.001;
      img.style.width = `${Math.max(1, Math.round(w * scale))}px`;
      stage.classList.toggle('zoomed', zoomed);
      stage.classList.toggle('crisp', pixel && scale > 1);
      const after = img.getBoundingClientRect();
      stage.scrollLeft += after.left + px * scale - (box.left + x);
      stage.scrollTop += after.top + py * scale - (box.top + y);
      syncHint();
    };

    img.style.maxWidth = 'none';
    zoomTo(base());
    hint.hidden = false;
    stage.tabIndex = 0;
    stage.setAttribute('role', 'group');

    // Scroll to zoom around the pointer. Zooming out past the start lets the page scroll.
    stage.addEventListener(
      'wheel',
      e => {
        if (e.ctrlKey) return; // the browser's own page zoom
        const delta = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
        if (delta > 0 && !zoomed) return;
        e.preventDefault();
        const box = stage.getBoundingClientRect();
        zoomTo(scale * Math.exp(-delta * 0.002), e.clientX - box.left, e.clientY - box.top);
      },
      { passive: false },
    );

    // Drag to move around a zoomed picture; a press without a drag is a click.
    let drag = null;
    let dragged = false;
    stage.addEventListener('pointerdown', e => {
      if (e.pointerType !== 'mouse' || e.button !== 0 || !zoomed) return;
      drag = { x: e.clientX, y: e.clientY, left: stage.scrollLeft, top: stage.scrollTop };
      dragged = false;
    });
    addEventListener('pointermove', e => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!dragged && Math.hypot(dx, dy) < 4) return;
      if (!dragged) {
        dragged = true;
        stage.classList.add('dragging');
      }
      stage.scrollLeft = drag.left - dx;
      stage.scrollTop = drag.top - dy;
    });
    addEventListener('pointerup', () => {
      drag = null;
      stage.classList.remove('dragging');
    });

    // Click zooms in at that spot (twice the size); a click while zoomed goes back.
    stage.addEventListener('click', e => {
      if (dragged) {
        dragged = false;
        return;
      }
      const box = stage.getBoundingClientRect();
      if (zoomed) zoomTo(base());
      else zoomTo(Math.max(scale * 2, 1), e.clientX - box.left, e.clientY - box.top);
    });

    stage.addEventListener('keydown', e => {
      const step = { '+': 1.25, '=': 1.25, '-': 0.8, _: 0.8 }[e.key];
      if (step) zoomTo(scale * step);
      else if (e.key === '0' || (e.key === 'Escape' && zoomed)) zoomTo(base());
      else if (e.key === 'Enter' || e.key === ' ')
        zoomed ? zoomTo(base()) : zoomTo(Math.max(scale * 2, 1));
      else return;
      e.preventDefault();
    });

    addEventListener('resize', () => zoomTo(zoomed ? scale : base()));
  };

  const failed = () => {
    hint.hidden = true;
    toast('Couldn’t show this picture.', {
      type: 'error',
      detail: 'Your browser may not support its format. Download it instead.',
    });
  };
  // This module runs after the picture may already have loaded or failed, so check both.
  if (img.complete) {
    if (img.naturalWidth) ready();
    else failed();
  } else {
    img.addEventListener('load', ready, { once: true });
    img.addEventListener('error', failed, { once: true });
  }
}

// ---------- video / audio ----------

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3];

function initPlayer() {
  const player = document.getElementById('player');
  const media = /** @type {HTMLMediaElement} */ (document.getElementById('media'));
  const controls = document.getElementById('controls');
  const seek = /** @type {HTMLInputElement} */ (document.getElementById('seek'));
  const volume = /** @type {HTMLInputElement} */ (document.getElementById('volume'));
  const speedOut = document.getElementById('speed');
  const pitch = /** @type {HTMLInputElement} */ (document.getElementById('pitch'));
  const buffering = document.getElementById('buffering');
  const btn = act => controls.querySelector(`[data-act="${act}"]`);
  const isVideo = kind === 'video';

  // Native controls are the no-JS fallback; ours take over now.
  media.controls = false;
  controls.hidden = false;

  const fill = input => {
    const max = Number(input.max) || 1;
    input.style.setProperty('--fill', `${(Number(input.value) / max) * 100}%`);
  };

  // play / pause
  const play = btn('play');
  const syncPlay = () => {
    const paused = media.paused;
    showPart(play, paused ? 'paused' : 'playing');
    setLabel(play, paused ? 'Play' : 'Pause');
  };
  const toggle = () => (media.paused ? media.play().catch(() => {}) : media.pause());
  play.addEventListener('click', toggle);
  media.addEventListener('play', syncPlay);
  media.addEventListener('pause', syncPlay);
  if (isVideo) {
    // A double-click means full screen; wait a beat so it doesn't also play and pause.
    let clickTimer = 0;
    media.addEventListener('click', e => {
      clearTimeout(clickTimer);
      if (e.detail > 1) return;
      clickTimer = setTimeout(toggle, 220);
    });
    media.addEventListener('dblclick', () => {
      clearTimeout(clickTimer);
      fullscreen();
    });
  }

  // time and seeking
  const cur = document.getElementById('t-current');
  const dur = document.getElementById('t-duration');
  let scrubbing = false;
  const syncTime = () => {
    cur.textContent = formatDuration(media.currentTime);
    if (!scrubbing) {
      seek.value = String(media.currentTime);
      fill(seek);
    }
    seek.setAttribute(
      'aria-valuetext',
      `${formatDuration(media.currentTime)} of ${formatDuration(media.duration)}`,
    );
  };
  media.addEventListener('timeupdate', syncTime);
  media.addEventListener('durationchange', () => {
    seek.max = String(Number.isFinite(media.duration) ? media.duration : 0);
    dur.textContent = formatDuration(media.duration);
    syncTime();
  });
  let metaShown = false;
  media.addEventListener('loadedmetadata', () => {
    if (metaShown) return;
    metaShown = true;
    if (isVideo && media.videoWidth)
      addMeta(`${groupThousands(media.videoWidth)} × ${groupThousands(media.videoHeight)}`);
    if (Number.isFinite(media.duration)) addMeta(formatDuration(media.duration));
  });
  seek.addEventListener('input', () => {
    scrubbing = true;
    media.currentTime = Number(seek.value);
    fill(seek);
  });
  seek.addEventListener('change', () => (scrubbing = false));
  // The slider's own arrow step is 1 % of the file (36 s on an hour); use the player's steps.
  const SEEK_KEYS = {
    ArrowLeft: -5,
    ArrowDown: -5,
    ArrowRight: 5,
    ArrowUp: 5,
    PageDown: -30,
    PageUp: 30,
  };
  seek.addEventListener('keydown', e => {
    const jump = SEEK_KEYS[e.key];
    if (jump === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    media.currentTime = Math.min(Math.max(0, media.currentTime + jump), media.duration || 0);
  });

  // volume
  const mute = btn('mute');
  const syncVolume = () => {
    const silent = media.muted || media.volume === 0;
    showPart(mute, silent ? 'muted' : 'sound');
    setLabel(mute, silent ? 'Unmute' : 'Mute');
    const shown = media.muted ? 0 : media.volume;
    volume.value = String(shown);
    volume.setAttribute('aria-valuetext', `${Math.round(shown * 100)} %`);
    fill(volume);
  };
  // Restore what was playing last time: the level and whether it was muted.
  const savedVolume = Number(store.get(STORAGE.volume));
  if (store.get(STORAGE.volume) != null && savedVolume > 0 && savedVolume <= 1)
    media.volume = savedVolume;
  media.muted = store.get(STORAGE.muted) === '1';
  volume.addEventListener('input', () => {
    media.volume = Number(volume.value);
    media.muted = media.volume === 0;
  });
  const toggleMute = () => {
    if (media.muted && media.volume === 0) media.volume = 1;
    media.muted = !media.muted;
  };
  mute.addEventListener('click', toggleMute);
  media.addEventListener('volumechange', () => {
    syncVolume();
    // Level 0 is kept as "muted", so a reload never comes back silent with no reason shown.
    if (media.volume > 0) store.set(STORAGE.volume, String(media.volume));
    store.set(STORAGE.muted, media.muted || media.volume === 0 ? '1' : null);
  });
  syncVolume();

  // speed and pitch
  const MIN_SPEED = SPEEDS[0];
  const MAX_SPEED = SPEEDS[SPEEDS.length - 1];
  const setSpeed = rate => {
    media.playbackRate = rate;
    speedOut.textContent = `${formatDecimal(rate)}×`;
    // aria-disabled, not disabled: a disabled button would drop keyboard focus at the limit.
    btn('slower').setAttribute('aria-disabled', String(rate <= MIN_SPEED));
    btn('faster').setAttribute('aria-disabled', String(rate >= MAX_SPEED));
  };
  const step = dir => {
    const rate = media.playbackRate;
    const next =
      dir > 0
        ? SPEEDS.find(s => s > rate + 1e-6)
        : [...SPEEDS].reverse().find(s => s < rate - 1e-6);
    if (next) setSpeed(next);
  };
  for (const [act, dir] of [
    ['slower', -1],
    ['faster', 1],
  ]) {
    const b = btn(act);
    b.addEventListener('click', () => b.getAttribute('aria-disabled') !== 'true' && step(dir));
  }
  pitch.addEventListener('change', () => {
    media.preservesPitch = pitch.checked;
    media.mozPreservesPitch = pitch.checked;
  });

  // loop
  const loop = btn('loop');
  loop.addEventListener('click', () => {
    media.loop = !media.loop;
    loop.setAttribute('aria-pressed', String(media.loop));
  });

  // full screen (video only)
  const fsBtn = btn('fullscreen');
  const fullscreen = () => {
    if (!fsBtn) return;
    if (document.fullscreenElement) document.exitFullscreen();
    else player.requestFullscreen?.().catch(() => {});
  };
  if (fsBtn) {
    if (!document.fullscreenEnabled) fsBtn.hidden = true;
    fsBtn.addEventListener('click', fullscreen);
    document.addEventListener('fullscreenchange', () => {
      const on = document.fullscreenElement === player;
      showPart(fsBtn, on ? 'fullscreen' : 'windowed');
      setLabel(fsBtn, on ? 'Exit full screen' : 'Full screen');
    });
  }

  // buffering
  let bufferTimer = 0;
  media.addEventListener('waiting', () => {
    clearTimeout(bufferTimer);
    bufferTimer = setTimeout(() => (buffering.hidden = false), 300); // don't flash on quick stalls
  });
  for (const ev of ['playing', 'canplay', 'pause', 'seeked', 'error']) {
    media.addEventListener(ev, () => {
      clearTimeout(bufferTimer);
      buffering.hidden = true;
    });
  }

  media.addEventListener('error', () => {
    controls.querySelectorAll('button, input').forEach(c => (c.disabled = true));
    toast(`Couldn’t play this ${kind} here.`, {
      type: 'error',
      detail: 'Your browser may not support its format. Download it and open it in a player.',
    });
  });

  // Keyboard, when focus isn't in a field.
  document.addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t.closest?.('input, textarea, select, [contenteditable]')) return;
    const onButton = t.closest?.('button, a');
    switch (e.key) {
      case ' ':
        if (onButton) return; // let the button do its own thing
      // fallthrough
      case 'k':
      case 'K':
        toggle();
        break;
      case 'ArrowLeft':
        media.currentTime = Math.max(0, media.currentTime - 5);
        break;
      case 'ArrowRight':
        media.currentTime = Math.min(media.duration || 0, media.currentTime + 5);
        break;
      case 'm':
      case 'M':
        toggleMute();
        break;
      case 'f':
      case 'F':
        fullscreen();
        break;
      default:
        return;
    }
    e.preventDefault();
  });

  // Links can carry a start time and speed: #t=1:23&speed=1.5 (upstream's #speed= still works).
  const fromHash = () => {
    const params = new URLSearchParams(location.hash.slice(1));
    const t = params.get('t')?.split(':');
    if (t && t.length <= 3) {
      const secs = t.reduce((acc, part) => acc * 60 + Number(part), 0);
      if (Number.isFinite(secs) && secs >= 0) media.currentTime = secs;
    }
    // "1,5" as the player shows it, or "1.5".
    const speed = Number(params.get('speed')?.replace(',', '.'));
    if (speed > 0) setSpeed(Math.min(Math.max(speed, MIN_SPEED), MAX_SPEED));
    if (params.get('preserve') === 'false') {
      pitch.checked = false;
      pitch.dispatchEvent(new Event('change'));
    }
  };
  addEventListener('hashchange', fromHash);
  fromHash();

  setSpeed(media.playbackRate || 1);
  syncPlay();
  fill(seek);
}

// ---------- text ----------

const TEXT_LIMIT = 2 * 1024 * 1024; // show at most this much in the page
const HIGHLIGHT_LIMIT = 300 * 1024; // auto-detecting the language gets slow past this
const MIN_GUESS_RELEVANCE = 10; // below this, highlight.js is guessing from a few tokens

async function initText() {
  const code = document.getElementById('code');
  const out = document.getElementById('text');
  const gutter = document.getElementById('gutter');
  const info = document.getElementById('text-info');
  const notice = document.getElementById('text-notice');
  const wrapBtn = document.getElementById('wrap-toggle');
  const hlBtn = document.getElementById('highlight-toggle');
  const copyBtn = document.getElementById('copy-text');

  let text;
  try {
    const partial = bytes > TEXT_LIMIT;
    const res = await fetch(
      raw,
      partial ? { headers: { Range: `bytes=0-${TEXT_LIMIT - 1}` } } : {},
    );
    if (!res.ok) throw new Error(String(res.status));
    text = new TextDecoder().decode(await res.arrayBuffer());
    if (partial) {
      // Drop a line cut in half by the range.
      const cut = text.lastIndexOf('\n');
      if (cut > 0) text = text.slice(0, cut);
      notice.textContent = `Showing the first ${formatSize(TEXT_LIMIT)}. Download the file for the rest.`;
      notice.hidden = false;
    }
  } catch {
    info.textContent = 'Couldn’t load the text.';
    toast('Couldn’t load the text.', { type: 'error', detail: 'Reload the page to try again.' });
    return;
  }

  // Bytes that aren't text (a binary file named .txt): say so instead of showing noise.
  const sample = text.slice(0, 8192);
  const junk = (sample.match(/[\0\uFFFD]/g) ?? []).length;
  if (sample.includes('\0') || junk > sample.length / 20) {
    info.textContent = 'This file isn’t readable text.';
    code.hidden = true;
    notice.textContent = 'It looks like binary data. Download it to open it in the right app.';
    notice.hidden = false;
    hlBtn.hidden = true;
    wrapBtn.hidden = true;
    copyBtn.hidden = true;
    return;
  }

  const lines = text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  const lineLabel = `${groupThousands(lines)} ${lines === 1 ? 'line' : 'lines'}`;
  info.textContent = lineLabel;
  out.textContent = text;
  gutter.textContent = Array.from({ length: Math.max(lines, 1) }, (_, i) => i + 1).join('\n');
  copyBtn.disabled = false;
  copyBtn.addEventListener('click', async () => {
    // A shortened view still copies the whole file.
    if (bytes <= TEXT_LIMIT) return copy(text, copyBtn);
    try {
      const res = await fetch(raw);
      if (!res.ok) throw new Error(String(res.status));
      copy(await res.text(), copyBtn);
    } catch {
      toast('Couldn’t copy the whole file.', { type: 'error', detail: 'Download it instead.' });
    }
  });
  // The box only needs to be a tab stop when it scrolls.
  const syncScrollable = () => {
    const scrolls = code.scrollHeight > code.clientHeight || code.scrollWidth > code.clientWidth;
    if (scrolls) code.tabIndex = 0;
    else code.removeAttribute('tabindex');
  };
  addEventListener('resize', syncScrollable);

  // wrap
  const setWrap = on => {
    code.classList.toggle('is-wrapped', on);
    wrapBtn.setAttribute('aria-pressed', String(on));
    store.set(STORAGE.wrap, on ? '1' : null);
  };
  wrapBtn.addEventListener('click', () => {
    setWrap(!code.classList.contains('is-wrapped'));
    syncScrollable();
  });
  setWrap(store.get(STORAGE.wrap) === '1');
  syncScrollable();

  // highlight
  if (text.length > HIGHLIGHT_LIMIT) {
    hlBtn.disabled = true;
    hlBtn.dataset.hint = `Off for files over ${formatSize(HIGHLIGHT_LIMIT)}.`;
    return;
  }
  let highlighted = false;
  const setHighlight = async on => {
    hlBtn.setAttribute('aria-pressed', String(on));
    store.set(STORAGE.highlight, on ? '1' : null);
    if (!on) {
      out.textContent = text;
      out.className = '';
      info.textContent = lineLabel;
      highlighted = false;
      return;
    }
    if (highlighted) return;
    try {
      const { default: hljs } = await import('../lib/highlight.min.js');
      // Use the extension when it names a language; otherwise guess, but only keep a confident
      // guess, so a short note or a log doesn't come out as "CSS".
      const named = hljs.getLanguage(ext);
      let result = null;
      if (named && named.name !== 'Plain text') result = hljs.highlight(text, { language: ext });
      else {
        const guess = hljs.highlightAuto(text);
        if (guess.relevance >= MIN_GUESS_RELEVANCE) result = guess;
      }
      if (hlBtn.getAttribute('aria-pressed') !== 'true') return; // turned off while loading
      highlighted = true;
      if (!result) {
        info.textContent = `${lineLabel} · No language found`;
        return;
      }
      out.innerHTML = result.value; // hljs escapes the source
      out.className = 'hljs';
      const lang = result.language && hljs.getLanguage(result.language)?.name;
      info.textContent = lang ? `${lineLabel} · ${lang}` : lineLabel;
    } catch {
      hlBtn.setAttribute('aria-pressed', 'false');
      toast('Couldn’t highlight this text.', { type: 'error' });
    }
  };
  hlBtn.addEventListener('click', () =>
    setHighlight(hlBtn.getAttribute('aria-pressed') !== 'true'),
  );
  if (store.get(STORAGE.highlight) === '1') setHighlight(true);
}

if (kind === 'image') initImage();
else if (kind === 'video' || kind === 'audio') initPlayer();
else if (kind === 'text') initText();
