import {
  copy,
  formatDecimal,
  formatDuration,
  groupThousands,
  setLabel,
  store,
  toast,
} from './ui.js';

const view = document.getElementById('view');
const { kind, raw, name } = view.dataset;
const bytes = Number(view.dataset.bytes);
const extra = document.getElementById('extra-meta');

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
    // Tiny pixel art scales up crisp instead of blurry.
    if (w <= 128 && h <= 128) stage.classList.add('pixel');
    const zoomable = () =>
      w > img.clientWidth + 1 || h > img.clientHeight + 1 || stage.classList.contains('actual');
    const sync = () => {
      const can = zoomable();
      hint.hidden = !can;
      if (can) {
        stage.tabIndex = 0;
        stage.setAttribute('role', 'button');
        const actual = stage.classList.contains('actual');
        stage.setAttribute('aria-label', actual ? 'Fit to window' : 'Show at full size');
        stage.setAttribute('aria-pressed', String(actual));
        hint.textContent = actual
          ? 'Click the picture to fit it to the window.'
          : 'Click the picture to see it at full size.';
      } else {
        stage.removeAttribute('tabindex');
        stage.removeAttribute('role');
        stage.removeAttribute('aria-label');
      }
    };
    const toggle = () => {
      if (!zoomable()) return;
      stage.classList.toggle('actual');
      sync();
    };
    stage.addEventListener('click', toggle);
    stage.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
      }
    });
    addEventListener('resize', sync);
    sync();
  };

  if (img.complete && img.naturalWidth) ready();
  else img.addEventListener('load', ready, { once: true });
  img.addEventListener('error', () => {
    hint.hidden = true;
    toast('Couldn’t show this picture.', {
      type: 'error',
      detail: 'Your browser may not support its format. Download it instead.',
    });
  });
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
    for (const part of play.querySelectorAll('[data-show]'))
      part.hidden = part.dataset.show !== (paused ? 'paused' : 'playing');
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

  // volume
  const mute = btn('mute');
  const syncVolume = () => {
    const silent = media.muted || media.volume === 0;
    for (const part of mute.querySelectorAll('[data-show]'))
      part.hidden = part.dataset.show !== (silent ? 'muted' : 'sound');
    setLabel(mute, silent ? 'Unmute' : 'Mute');
    volume.value = String(media.muted ? 0 : media.volume);
    fill(volume);
  };
  const savedVolume = Number(store.get('cyexUploaderVolume'));
  if (store.get('cyexUploaderVolume') != null && savedVolume >= 0 && savedVolume <= 1)
    media.volume = savedVolume;
  volume.addEventListener('input', () => {
    media.volume = Number(volume.value);
    media.muted = media.volume === 0;
    store.set('cyexUploaderVolume', String(media.volume));
  });
  mute.addEventListener('click', () => {
    if (media.muted && media.volume === 0) media.volume = 1;
    media.muted = !media.muted;
  });
  media.addEventListener('volumechange', syncVolume);
  syncVolume();

  // speed and pitch
  const setSpeed = rate => {
    media.playbackRate = rate;
    speedOut.textContent = `${formatDecimal(rate)}×`;
    btn('slower').disabled = rate <= SPEEDS[0];
    btn('faster').disabled = rate >= SPEEDS[SPEEDS.length - 1];
  };
  const step = dir => {
    const rate = media.playbackRate;
    const next =
      dir > 0
        ? SPEEDS.find(s => s > rate + 1e-6)
        : [...SPEEDS].reverse().find(s => s < rate - 1e-6);
    if (next) setSpeed(next);
  };
  btn('slower').addEventListener('click', () => step(-1));
  btn('faster').addEventListener('click', () => step(1));
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
  function fullscreen() {
    if (!fsBtn) return;
    if (document.fullscreenElement) document.exitFullscreen();
    else player.requestFullscreen?.().catch(() => {});
  }
  if (fsBtn) {
    if (!document.fullscreenEnabled) fsBtn.hidden = true;
    fsBtn.addEventListener('click', fullscreen);
    document.addEventListener('fullscreenchange', () => {
      const on = document.fullscreenElement === player;
      for (const part of fsBtn.querySelectorAll('[data-show]'))
        part.hidden = part.dataset.show !== (on ? 'fullscreen' : 'windowed');
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
        mute.click();
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
    const t = params.get('t');
    if (t) {
      const secs = t.split(':').reduce((acc, part) => acc * 60 + Number(part), 0);
      if (Number.isFinite(secs)) media.currentTime = secs;
    }
    const speed = Number(params.get('speed'));
    if (speed > 0) setSpeed(Math.min(Math.max(speed, SPEEDS[0]), SPEEDS[SPEEDS.length - 1]));
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
      notice.textContent = 'Showing the first 2 MB. Download the file for the rest.';
      notice.hidden = false;
    }
  } catch {
    info.textContent = 'Couldn’t load the text.';
    toast('Couldn’t load the text.', { type: 'error', detail: 'Reload the page to try again.' });
    return;
  }

  const lines = text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  const lineLabel = `${groupThousands(lines)} ${lines === 1 ? 'line' : 'lines'}`;
  info.textContent = lineLabel;
  out.textContent = text;
  gutter.textContent = Array.from({ length: Math.max(lines, 1) }, (_, i) => i + 1).join('\n');
  copyBtn.disabled = false;
  copyBtn.addEventListener('click', () => copy(text, copyBtn));

  // wrap
  const setWrap = on => {
    code.classList.toggle('is-wrapped', on);
    wrapBtn.setAttribute('aria-pressed', String(on));
    store.set('cyexUploaderWrap', on ? '1' : null);
  };
  wrapBtn.addEventListener('click', () => setWrap(!code.classList.contains('is-wrapped')));
  setWrap(store.get('cyexUploaderWrap') === '1');

  // highlight
  if (text.length > HIGHLIGHT_LIMIT) {
    hlBtn.disabled = true;
    hlBtn.dataset.hint = 'Off for files over 300 KB.';
    return;
  }
  let highlighted = false;
  const setHighlight = async on => {
    hlBtn.setAttribute('aria-pressed', String(on));
    store.set('cyexUploaderHighlight', on ? '1' : null);
    if (!on) {
      out.textContent = text;
      out.className = '';
      info.textContent = lineLabel;
      highlighted = false;
      return;
    }
    if (highlighted) return;
    try {
      const { default: hljs } = await import('/static/lib/highlight.min.js');
      // Pick a language from the extension when hljs knows it, otherwise let it guess.
      const ext = ['txt', 'text', 'log'].includes(view.dataset.ext) ? '' : view.dataset.ext;
      const result =
        ext && hljs.getLanguage(ext)
          ? hljs.highlight(text, { language: ext })
          : hljs.highlightAuto(text);
      if (hlBtn.getAttribute('aria-pressed') !== 'true') return; // turned off while loading
      out.innerHTML = result.value; // hljs escapes the source
      out.className = 'hljs';
      highlighted = true;
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
  if (store.get('cyexUploaderHighlight') === '1') setHighlight(true);
}

if (kind === 'image') initImage();
else if (kind === 'video' || kind === 'audio') initPlayer();
else if (kind === 'text') initText();
