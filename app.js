'use strict';

const LAME_URL = 'https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js';
const SAMPLE_RATE = 44100;
const MIN_SEGMENT = 0.01; // seconds

const $ = (id) => document.getElementById(id);
const video = $('video');
const canvas = $('timeline');
const ctx2d = canvas.getContext('2d');

const state = {
  fileName: '',
  audio: null,        // AudioBuffer
  duration: 0,
  segments: [],       // [{ start, end, removed }]
  selected: -1,
  history: [],
  peaks: null,
};

// ---------- Utilities ----------

function fmt(t) {
  if (!isFinite(t)) t = 0;
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

function baseName(name) {
  return name.replace(/\.[^.]+$/, '') || 'audio';
}

function keptSegments() {
  return state.segments.filter((s) => !s.removed);
}

function keptDuration() {
  return keptSegments().reduce((sum, s) => sum + (s.end - s.start), 0);
}

function segmentIndexAt(t) {
  const i = state.segments.findIndex((s) => t >= s.start && t < s.end);
  return i === -1 ? state.segments.length - 1 : i;
}

// ---------- Loading ----------

$('fileInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) loadFile(file);
  e.target.value = '';
});

document.addEventListener('dragover', (e) => {
  e.preventDefault();
  document.body.classList.add('dragging');
});
document.addEventListener('dragleave', (e) => {
  if (e.relatedTarget === null) document.body.classList.remove('dragging');
});
document.addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.classList.remove('dragging');
  const file = e.dataTransfer.files[0];
  if (file) loadFile(file);
});

async function loadFile(file) {
  $('fileName').textContent = `Loading ${file.name}…`;
  if (video.src) URL.revokeObjectURL(video.src);
  video.src = URL.createObjectURL(file);

  try {
    const data = await file.arrayBuffer();
    const actx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SAMPLE_RATE });
    state.audio = await actx.decodeAudioData(data);
    actx.close();
  } catch (err) {
    console.error(err);
    $('fileName').textContent = `${file.name} — could not read audio from this file (no audio track or unsupported format).`;
    return;
  }

  state.fileName = file.name;
  state.duration = state.audio.duration;
  state.segments = [{ start: 0, end: state.duration, removed: false }];
  state.selected = 0;
  state.history = [];
  state.peaks = null;

  $('fileName').textContent = file.name;
  $('dropZone').hidden = true;
  $('editor').hidden = false;
  resizeCanvas();
  update();
}

// ---------- Editing ----------

function pushHistory() {
  state.history.push(JSON.stringify({ segments: state.segments, selected: state.selected }));
  if (state.history.length > 100) state.history.shift();
}

function undo() {
  const prev = state.history.pop();
  if (!prev) return;
  Object.assign(state, JSON.parse(prev));
  update();
}

// Splits the segment under time t. Returns true if a split happened.
function splitAt(t) {
  const i = segmentIndexAt(t);
  const seg = state.segments[i];
  if (!seg || t - seg.start < MIN_SEGMENT || seg.end - t < MIN_SEGMENT) return false;
  state.segments.splice(i, 1,
    { start: seg.start, end: t, removed: seg.removed },
    { start: t, end: seg.end, removed: seg.removed });
  return true;
}

function split() {
  pushHistory();
  if (!splitAt(video.currentTime)) state.history.pop();
  state.selected = segmentIndexAt(video.currentTime);
  update();
}

function toggleSelected() {
  const seg = state.segments[state.selected];
  if (!seg) return;
  pushHistory();
  seg.removed = !seg.removed;
  update();
}

function trimStart() {
  const t = video.currentTime;
  pushHistory();
  splitAt(t);
  state.segments.forEach((s) => { if (s.end <= t + 1e-9) s.removed = true; });
  state.selected = segmentIndexAt(t);
  update();
}

function trimEnd() {
  const t = video.currentTime;
  pushHistory();
  splitAt(t);
  state.segments.forEach((s) => { if (s.start >= t - 1e-9) s.removed = true; });
  state.selected = Math.max(0, segmentIndexAt(t) - 1);
  update();
}

function resetCuts() {
  pushHistory();
  state.segments = [{ start: 0, end: state.duration, removed: false }];
  state.selected = 0;
  update();
}

$('splitBtn').onclick = split;
$('toggleBtn').onclick = toggleSelected;
$('trimStartBtn').onclick = trimStart;
$('trimEndBtn').onclick = trimEnd;
$('undoBtn').onclick = undo;
$('resetBtn').onclick = resetCuts;

document.addEventListener('keydown', (e) => {
  if (!state.audio || e.target.matches('input, select, textarea')) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  switch (e.key) {
    case ' ': e.preventDefault(); togglePlay(); break;
    case 's': case 'S': split(); break;
    case 'Delete': case 'Backspace': e.preventDefault(); toggleSelected(); break;
    case '[': trimStart(); break;
    case ']': trimEnd(); break;
    case 'ArrowLeft': video.currentTime = Math.max(0, video.currentTime - (e.shiftKey ? 1 : 0.1)); break;
    case 'ArrowRight': video.currentTime = Math.min(state.duration, video.currentTime + (e.shiftKey ? 1 : 0.1)); break;
  }
});

// ---------- Playback ----------

function togglePlay() {
  if (video.paused) video.play(); else video.pause();
}

$('playBtn').onclick = togglePlay;
video.addEventListener('play', () => { $('playBtn').textContent = 'Pause'; });
video.addEventListener('pause', () => { $('playBtn').textContent = 'Play'; });

// Skip over removed segments while playing.
function skipRemoved() {
  if (video.paused || !$('skipCuts').checked || !state.segments.length) return;
  const t = video.currentTime;
  const seg = state.segments[segmentIndexAt(t)];
  if (!seg || !seg.removed) return;
  const next = state.segments.find((s) => !s.removed && s.start >= seg.end - 1e-9);
  if (next) video.currentTime = next.start;
  else video.pause();
}

function tick() {
  skipRemoved();
  if (state.audio) {
    $('timeLabel').textContent = `${fmt(video.currentTime)} / ${fmt(state.duration)}`;
    draw();
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ---------- Timeline ----------

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  state.peaks = null;
}
window.addEventListener('resize', () => { if (state.audio) resizeCanvas(); });

function computePeaks(width) {
  const buf = state.audio;
  const len = buf.length;
  const chans = [];
  for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
  const peaks = new Float32Array(width);
  const step = len / width;
  for (let x = 0; x < width; x++) {
    const from = Math.floor(x * step);
    const to = Math.min(len, Math.floor((x + 1) * step));
    const stride = Math.max(1, Math.floor((to - from) / 400)); // sample sparsely for speed
    let max = 0;
    for (const data of chans) {
      for (let i = from; i < to; i += stride) {
        const v = Math.abs(data[i]);
        if (v > max) max = v;
      }
    }
    peaks[x] = max;
  }
  return peaks;
}

function draw() {
  const w = canvas.width;
  const h = canvas.height;
  if (!state.peaks || state.peaks.length !== w) state.peaks = computePeaks(w);
  const dpr = window.devicePixelRatio || 1;
  const pxPerSec = w / state.duration;
  const mid = h / 2;

  ctx2d.clearRect(0, 0, w, h);

  state.segments.forEach((s, i) => {
    const x0 = s.start * pxPerSec;
    const x1 = s.end * pxPerSec;
    ctx2d.fillStyle = s.removed ? 'rgba(217,83,79,0.18)' : 'rgba(63,178,127,0.10)';
    ctx2d.fillRect(x0, 0, x1 - x0, h);

    ctx2d.fillStyle = s.removed ? 'rgba(217,83,79,0.55)' : '#3fb27f';
    for (let x = Math.floor(x0); x < Math.min(w, Math.ceil(x1)); x++) {
      const amp = Math.max(1, state.peaks[x] * (mid - 6 * dpr));
      ctx2d.fillRect(x, mid - amp, 1, amp * 2);
    }

    if (i === state.selected) {
      ctx2d.strokeStyle = '#4f8cff';
      ctx2d.lineWidth = 2 * dpr;
      ctx2d.strokeRect(x0 + dpr, dpr, x1 - x0 - 2 * dpr, h - 2 * dpr);
    }
    if (i > 0) {
      ctx2d.fillStyle = '#e6e8ee';
      ctx2d.fillRect(x0 - dpr / 2, 0, dpr, h);
    }
  });

  const px = video.currentTime * pxPerSec;
  ctx2d.fillStyle = '#ffcc33';
  ctx2d.fillRect(px - dpr, 0, 2 * dpr, h);
}

canvas.addEventListener('pointerdown', (e) => {
  if (!state.audio) return;
  const rect = canvas.getBoundingClientRect();
  const seek = (ev) => {
    const t = Math.min(state.duration, Math.max(0, ((ev.clientX - rect.left) / rect.width) * state.duration));
    video.currentTime = t;
    return t;
  };
  const t = seek(e);
  state.selected = segmentIndexAt(t);
  renderList();
  canvas.setPointerCapture(e.pointerId);
  canvas.onpointermove = seek;
  canvas.onpointerup = () => { canvas.onpointermove = null; };
});

// ---------- Segment list ----------

function renderList() {
  const rows = state.segments.map((s, i) => `
    <tr data-i="${i}" class="${s.removed ? 'removed' : ''} ${i === state.selected ? 'selected' : ''}">
      <td>${i + 1}</td><td>${fmt(s.start)}</td><td>${fmt(s.end)}</td>
      <td>${fmt(s.end - s.start)}</td><td>${s.removed ? 'Removed' : 'Kept'}</td>
    </tr>`).join('');
  $('segmentList').innerHTML = rows;
}

$('segmentList').addEventListener('click', (e) => {
  const row = e.target.closest('tr');
  if (!row) return;
  state.selected = Number(row.dataset.i);
  video.currentTime = state.segments[state.selected].start;
  renderList();
});

function update() {
  renderList();
  const kept = keptSegments().length;
  $('summary').textContent = kept
    ? `Output length: ${fmt(keptDuration())} from ${kept} kept segment${kept === 1 ? '' : 's'} (original ${fmt(state.duration)}).`
    : 'Everything is removed — restore a segment to export.';
  $('exportBtn').disabled = kept === 0;
  $('undoBtn').disabled = state.history.length === 0;
  const seg = state.segments[state.selected];
  $('toggleBtn').textContent = seg && seg.removed ? 'Restore segment' : 'Remove segment';
}

// ---------- Export ----------

$('format').addEventListener('change', () => {
  $('bitrateLabel').hidden = $('format').value !== 'mp3';
});

$('exportBtn').onclick = async () => {
  const btn = $('exportBtn');
  const status = $('exportStatus');
  btn.disabled = true;
  try {
    status.textContent = 'Preparing audio…';
    const channels = renderKeptAudio();
    let blob;
    let ext;
    if ($('format').value === 'mp3') {
      status.textContent = 'Loading MP3 encoder…';
      await loadLame();
      blob = await encodeMp3(channels, SAMPLE_RATE, Number($('bitrate').value), (p) => {
        status.textContent = `Encoding MP3… ${Math.round(p * 100)}%`;
      });
      ext = 'mp3';
    } else {
      blob = encodeWav(channels, SAMPLE_RATE);
      ext = 'wav';
    }
    download(blob, `${baseName(state.fileName)}_edited.${ext}`);
    status.textContent = `Done — ${(blob.size / 1024 / 1024).toFixed(2)} MB`;
  } catch (err) {
    console.error(err);
    status.textContent = `Export failed: ${err.message}`;
  } finally {
    btn.disabled = keptSegments().length === 0;
  }
};

// Concatenates the kept segments. Returns one Float32Array per channel (max 2).
function renderKeptAudio() {
  const buf = state.audio;
  const rate = buf.sampleRate;
  const ranges = keptSegments().map((s) => [
    Math.round(s.start * rate),
    Math.min(buf.length, Math.round(s.end * rate)),
  ]);
  const total = ranges.reduce((n, [a, b]) => n + (b - a), 0);
  const src = [];
  for (let c = 0; c < buf.numberOfChannels; c++) src.push(buf.getChannelData(c));

  const outCount = Math.min(2, src.length);
  const out = Array.from({ length: outCount }, () => new Float32Array(total));
  // Short fade at each join to avoid clicks.
  const fade = Math.min(Math.round(rate * 0.005), 256);

  let pos = 0;
  for (const [a, b] of ranges) {
    const len = b - a;
    for (let c = 0; c < outCount; c++) {
      let data;
      if (src.length > 2) {
        // Downmix surround to stereo by averaging channels of the same side.
        data = new Float32Array(len);
        const group = src.filter((_, i) => i % 2 === c);
        for (const ch of group) for (let i = 0; i < len; i++) data[i] += ch[a + i] / group.length;
      } else {
        data = src[c].subarray(a, b);
      }
      out[c].set(data, pos);
      if (ranges.length > 1) {
        const f = Math.min(fade, Math.floor(len / 2));
        for (let i = 0; i < f; i++) {
          const g = i / f;
          out[c][pos + i] *= g;
          out[c][pos + len - 1 - i] *= g;
        }
      }
    }
    pos += len;
  }
  return out;
}

function encodeWav(channels, rate) {
  const numCh = channels.length;
  const len = channels[0].length;
  const bytes = len * numCh * 2;
  const buf = new ArrayBuffer(44 + bytes);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + bytes, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, numCh, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * numCh * 2, true); v.setUint16(32, numCh * 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, bytes, true);
  let o = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < numCh; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([buf], { type: 'audio/wav' });
}

function loadLame() {
  if (window.lamejs) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = LAME_URL;
    s.onload = resolve;
    s.onerror = () => reject(new Error('could not load the MP3 encoder (are you offline?). Try WAV instead.'));
    document.head.appendChild(s);
  });
}

function toInt16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

async function encodeMp3(channels, rate, kbps, onProgress) {
  const numCh = channels.length;
  const encoder = new lamejs.Mp3Encoder(numCh, rate, kbps);
  const left = toInt16(channels[0]);
  const right = numCh > 1 ? toInt16(channels[1]) : null;
  const parts = [];
  const block = 1152;
  const perYield = block * 200;
  for (let i = 0; i < left.length; i += block) {
    const l = left.subarray(i, i + block);
    const mp3 = right ? encoder.encodeBuffer(l, right.subarray(i, i + block)) : encoder.encodeBuffer(l);
    if (mp3.length) parts.push(new Uint8Array(mp3));
    if (i % perYield === 0) {
      onProgress(i / left.length);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  const end = encoder.flush();
  if (end.length) parts.push(new Uint8Array(end));
  onProgress(1);
  return new Blob(parts, { type: 'audio/mpeg' });
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
