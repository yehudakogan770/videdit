'use strict';

// Audio is processed by ffmpeg (WebAssembly) in a background worker. The input
// file is mounted lazily (WORKERFS reads only the slices ffmpeg asks for) and
// output is streamed out through a device file, so memory use stays small no
// matter how large the video is.
const CORE_BASE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/';
const OUT_RATE = 44100;
const PEAK_RATE = 8000;       // sample rate used to scan the waveform
const MIN_SEGMENT = 0.01;     // seconds
const MIN_VIEW = 0.5;         // shortest visible timeline span, seconds
const WAV_LIMIT = 0xffffffff - 36;
const DIRECT_SAVE_OVER = 1e9;  // bytes; bigger exports stream straight to disk

const $ = (id) => document.getElementById(id);
const video = $('video');
const canvas = $('timeline');
const ctx2d = canvas.getContext('2d');
const layer = document.createElement('canvas');
const layerCtx = layer.getContext('2d');

const state = {
  file: null,
  duration: 0,
  segments: [],       // [{ start, end, removed }]
  selected: -1,
  history: [],
  videoOK: false,
  nativePicture: false,
  playhead: 0,        // used when the browser can't play the video itself
  hasAudio: true,
  view: { start: 0, dur: 1 },
  peaks: null,        // Float32Array, one value per 1/pps seconds
  pps: 20,
  peakMax: 0.01,
  dirty: true,
  analysis: null,     // running waveform worker
  exporting: null,    // running export job
};

// ---------- Utilities ----------

function fmt(t, short) {
  if (!isFinite(t) || t < 0) t = 0;
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const sec = short ? String(Math.floor(s)).padStart(2, '0') : s.toFixed(2).padStart(5, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

function fmtBytes(n) {
  if (n > 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  return `${(n / 1e6).toFixed(1)} MB`;
}

function baseName(name) {
  return name.replace(/\.[^.]+$/, '') || 'audio';
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const keptSegments = () => state.segments.filter((s) => !s.removed);
const keptDuration = () => keptSegments().reduce((sum, s) => sum + (s.end - s.start), 0);

function segmentIndexAt(t) {
  const i = state.segments.findIndex((s) => t >= s.start && t < s.end);
  return i === -1 ? state.segments.length - 1 : i;
}

function getPlayhead() {
  return state.videoOK ? video.currentTime : state.playhead;
}

function setPlayhead(t) {
  t = clamp(t, 0, state.duration);
  state.playhead = t;
  if (state.videoOK) video.currentTime = t;
}

// ---------- ffmpeg worker ----------

// Runs inside the worker (serialized with toString()).
function workerMain() {
  let core = null;
  let sink = null;
  let onLog = null;

  function exec(args) {
    core.exec(...args);
    const ret = core.ret;
    core.reset();
    return ret;
  }

  async function init({ coreURL, wasmURL, file }) {
    importScripts(coreURL);
    core = await self.createFFmpegCore({
      mainScriptUrlOrBlob: `${coreURL}#${btoa(JSON.stringify({ wasmURL }))}`,
    });
    core.setLogger(({ message }) => { if (onLog) onLog(message); });
    const FS = core.FS;
    FS.mkdir('/mnt');
    FS.mount(FS.filesystems.WORKERFS, { blobs: [{ name: 'input', data: file }] }, '/mnt');
    const dev = FS.makedev(64, 0);
    FS.registerDevice(dev, {
      open() {},
      close() {},
      read() { return 0; },
      write(stream, buf, off, len) { if (sink) sink(buf.subarray(off, off + len)); return len; },
    });
    FS.mkdev('/out', dev);
  }

  function probe() {
    const lines = [];
    onLog = (m) => lines.push(m);
    exec(['-hide_banner', '-nostdin', '-i', '/mnt/input']);
    onLog = null;
    const text = lines.join('\n');
    const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
    const duration = d ? (+d[1]) * 3600 + (+d[2]) * 60 + (+d[3]) : 0;
    const hasAudio = /Stream #\d+:\d+.*: Audio:/.test(text);
    const hasVideo = /Stream #\d+:\d+.*: Video:(?!.*attached pic)/.test(text);
    self.postMessage({ type: 'probe', duration, hasAudio, hasVideo });
    return duration;
  }

  // Decodes the whole audio track at low rate and reports peak levels.
  function peaks({ pps, duration }) {
    const bucket = Math.round(8000 / pps);
    let out = new Float32Array(4096);
    let outLen = 0;
    let outIndex = 0;
    let max = 0;
    let count = 0;
    let carry = -1;
    let lastPost = 0;
    const flush = () => {
      if (!outLen) return;
      self.postMessage({ type: 'peaks', index: outIndex, data: out.slice(0, outLen) });
      outIndex += outLen;
      outLen = 0;
      lastPost = Date.now();
    };
    const sample = (v) => {
      const a = Math.abs(v) / 32768;
      if (a > max) max = a;
      if (++count === bucket) {
        out[outLen++] = max;
        max = 0;
        count = 0;
        if (outLen === out.length || Date.now() - lastPost > 250) {
          flush();
          if (duration) self.postMessage({ type: 'progress', value: outIndex / pps / duration });
        }
      }
    };
    sink = (bytes) => {
      let i = 0;
      if (carry >= 0 && bytes.length) {
        sample((bytes[0] << 8 | carry) << 16 >> 16);
        carry = -1;
        i = 1;
      }
      for (; i + 1 < bytes.length; i += 2) sample((bytes[i + 1] << 8 | bytes[i]) << 16 >> 16);
      if (i < bytes.length) carry = bytes[i];
    };
    const ret = exec(['-hide_banner', '-nostdin', '-i', '/mnt/input', '-map', '0:a:0', '-vn', '-sn', '-dn',
      '-ac', '1', '-ar', '8000', '-f', 's16le', '-y', '/out']);
    if (count) out[outLen++] = max;
    flush();
    sink = null;
    self.postMessage({ type: 'done', ret, duration: outIndex / pps });
  }

  // Cuts, joins and encodes the kept segments in a single ffmpeg run.
  function exportAudio({ segments, format, kbps, rate }) {
    const args = ['-hide_banner', '-nostdin'];
    const total = segments.reduce((n, s) => n + s.end - s.start, 0);
    const fade = 0.005;
    const chains = segments.map((s, i) => {
      const d = s.end - s.start;
      args.push('-ss', s.start.toFixed(6), '-t', d.toFixed(6), '-i', '/mnt/input');
      // Pad/trim so each piece is exactly as long as the segment.
      let chain = `[${i}:a:0]asetpts=PTS-STARTPTS,apad,atrim=duration=${d.toFixed(6)}`;
      if (segments.length > 1 && d > fade * 4) {
        chain += `,afade=t=in:d=${fade},afade=t=out:st=${(d - fade).toFixed(6)}:d=${fade}`;
      }
      return `${chain}[a${i}]`;
    });
    const labels = segments.map((_, i) => `[a${i}]`).join('');
    args.push('-filter_complex', `${chains.join(';')};${labels}concat=n=${segments.length}:v=0:a=1[out]`,
      '-map', '[out]', '-ac', '2', '-ar', String(rate));
    if (format === 'mp3') args.push('-c:a', 'libmp3lame', '-b:a', `${kbps}k`, '-write_xing', '0', '-f', 'mp3');
    else args.push('-c:a', 'pcm_s16le', '-f', 's16le');
    args.push('-y', '/out');

    const chunk = new Uint8Array(1 << 20);
    let used = 0;
    const flush = () => {
      if (!used) return;
      const bytes = chunk.slice(0, used);
      self.postMessage({ type: 'data', bytes }, [bytes.buffer]);
      used = 0;
    };
    sink = (bytes) => {
      let i = 0;
      while (i < bytes.length) {
        const n = Math.min(bytes.length - i, chunk.length - used);
        chunk.set(bytes.subarray(i, i + n), used);
        used += n;
        i += n;
        if (used === chunk.length) flush();
      }
    };
    const errors = [];
    onLog = (m) => {
      const t = /time=\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(m);
      if (t && total) self.postMessage({ type: 'progress', value: ((+t[1]) * 3600 + (+t[2]) * 60 + (+t[3])) / total });
      if (/error|invalid|failed/i.test(m)) errors.push(m);
    };
    const ret = exec(args);
    flush();
    sink = null;
    onLog = null;
    if (ret !== 0) throw new Error(errors.slice(-3).join(' ') || `ffmpeg exited with code ${ret}`);
    self.postMessage({ type: 'done', ret });
  }

  // Grabs one video frame as a PNG (used when the browser can't show the picture).
  // (This ffmpeg build crashes in its JPEG encoder, so PNG it is.)
  function frame({ id, t }) {
    const ret = exec(['-hide_banner', '-nostdin', '-ss', t.toFixed(3), '-i', '/mnt/input', '-map', '0:v:0',
      '-frames:v', '1', '-vf', 'scale=w=960:h=540:force_original_aspect_ratio=decrease',
      '-f', 'image2', '-c:v', 'png', '-compression_level', '1', '-y', '/frame.png']);
    let bytes = null;
    try {
      if (ret === 0) bytes = core.FS.readFile('/frame.png');
      core.FS.unlink('/frame.png');
    } catch (e) { /* no frame at this time */ }
    self.postMessage({ type: 'frame', id, t, bytes }, bytes ? [bytes.buffer] : []);
  }

  let ready = null;
  self.onmessage = async ({ data }) => {
    try {
      if (!ready) ready = init(data);
      await ready;
      if (data.task === 'frame') {
        frame(data);
      } else if (data.task === 'analyze') {
        const duration = probe();
        peaks({ pps: data.pps, duration: data.duration || duration });
      } else if (data.task === 'export') {
        exportAudio(data);
      }
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err && err.message || err) });
    }
  };
}

let workerURL = null;

// Starts a worker for one task. onEvent receives every message; the promise
// settles on 'done' or 'error'.
function runWorker(task, onEvent) {
  if (!workerURL) {
    workerURL = URL.createObjectURL(new Blob([`(${workerMain.toString()})()`], { type: 'text/javascript' }));
  }
  const worker = new Worker(workerURL);
  let rejectJob;
  const promise = new Promise((resolve, reject) => {
    rejectJob = reject;
    worker.onmessage = ({ data }) => {
      if (data.type === 'error') { worker.terminate(); reject(new Error(data.message)); return; }
      onEvent(data);
      if (data.type === 'done') { worker.terminate(); resolve(data); }
    };
    worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message || 'Worker failed')); };
  });
  worker.postMessage({
    coreURL: `${CORE_BASE}ffmpeg-core.js`,
    wasmURL: `${CORE_BASE}ffmpeg-core.wasm`,
    file: state.file,
    ...task,
  });
  return { promise, cancel: () => { worker.terminate(); rejectJob(new Error('cancelled')); } };
}

// ---------- Frame preview ----------
// When the browser can't decode the video picture (e.g. HEVC, MKV, AVI),
// ffmpeg draws the frame at the playhead instead.

const frames = {
  worker: null,
  busy: false,
  shownT: -1,
  nextId: 0,
  url: null,
};

function startFramePreview() {
  if (frames.worker) frames.worker.terminate();
  if (!workerURL) {
    workerURL = URL.createObjectURL(new Blob([`(${workerMain.toString()})()`], { type: 'text/javascript' }));
  }
  const worker = new Worker(workerURL);
  frames.worker = worker;
  frames.busy = false;
  frames.shownT = -1;
  worker.onmessage = ({ data }) => {
    if (worker !== frames.worker) return;
    if (data.type === 'error') { restartFramePreview(); return; }
    if (data.type !== 'frame') return;
    frames.busy = false;
    if (!data.bytes) return;
    if (frames.url) URL.revokeObjectURL(frames.url);
    frames.url = URL.createObjectURL(new Blob([data.bytes], { type: 'image/png' }));
    $('frameImg').src = frames.url;
    $('frameLoading').hidden = true;
  };
  worker.onerror = () => { if (worker === frames.worker) restartFramePreview(); };
  $('framePreview').hidden = false;
  if (!$('frameImg').getAttribute('src')) $('frameLoading').hidden = false;
}

// The engine can't recover from a crash, so start a fresh one (a few times at most).
function restartFramePreview() {
  frames.crashes = (frames.crashes || 0) + 1;
  frames.worker.terminate();
  frames.worker = null;
  if (frames.crashes <= 3) { startFramePreview(); return; }
  $('frameLoading').hidden = false;
  $('frameLoading').textContent = "Can't show this video's picture.";
}

function stopFramePreview() {
  if (frames.worker) frames.worker.terminate();
  frames.worker = null;
  frames.crashes = 0;
  $('frameLoading').textContent = 'Loading picture…';
  $('framePreview').hidden = true;
  $('frameImg').removeAttribute('src');
}

// Called every animation frame: fetch a new still when the playhead moved.
function updateFramePreview() {
  if (!frames.worker || frames.busy) return;
  const t = getPlayhead();
  if (Math.abs(t - frames.shownT) < 0.04) return;
  frames.busy = true;
  frames.shownT = t;
  frames.worker.postMessage({
    coreURL: `${CORE_BASE}ffmpeg-core.js`,
    wasmURL: `${CORE_BASE}ffmpeg-core.wasm`,
    file: state.file,
    task: 'frame',
    id: ++frames.nextId,
    t: Math.min(t, Math.max(0, state.duration - 0.05)),
  });
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

function waitForMetadata() {
  return new Promise((resolve) => {
    const done = (ok) => {
      video.removeEventListener('loadedmetadata', onMeta);
      video.removeEventListener('error', onErr);
      clearTimeout(timer);
      resolve(ok);
    };
    const onMeta = () => done(true);
    const onErr = () => done(false);
    const timer = setTimeout(() => done(false), 15000);
    video.addEventListener('loadedmetadata', onMeta);
    video.addEventListener('error', onErr);
  });
}

async function loadFile(file) {
  if (state.analysis) state.analysis.cancel();
  if (state.exporting) state.exporting.cancel();
  stopFramePreview();
  $('fileName').textContent = `Opening ${file.name} (${fmtBytes(file.size)})…`;
  $('editor').hidden = true;
  $('dropZone').hidden = false;

  state.file = file;
  state.duration = 0;
  state.peaks = null;
  state.peakMax = 0.01;
  state.hasAudio = true;

  // The <video> element streams from disk, so it's fine with huge files.
  if (video.src) URL.revokeObjectURL(video.src);
  video.src = URL.createObjectURL(file);
  state.videoOK = await waitForMetadata();
  if (state.file !== file) return;
  if (state.videoOK && isFinite(video.duration) && video.duration > 0) setDuration(video.duration);
  // Chrome sometimes plays only the sound of a video whose picture it can't
  // decode; then videoWidth stays 0. Keep the element for sound, hide it.
  state.nativePicture = state.videoOK && video.videoWidth > 0;
  video.hidden = !state.nativePicture;
  $('playBtn').disabled = !state.videoOK;
  stopFramePreview();

  analyze(file);
}

function setDuration(d) {
  if (state.duration === d) return;
  const first = !state.duration;
  state.duration = d;
  if (first) {
    state.segments = [{ start: 0, end: d, removed: false }];
    state.selected = 0;
    state.history = [];
    state.playhead = 0;
    state.view = { start: 0, dur: d };
    $('fileName').textContent = `${state.file.name} (${fmtBytes(state.file.size)}, ${fmt(d, true)})`;
    $('dropZone').hidden = true;
    $('editor').hidden = false;
    resizeCanvas();
  } else {
    // Refined duration: stretch/shrink the last segment boundary.
    const last = state.segments[state.segments.length - 1];
    if (last && d > last.start) last.end = d;
    state.view.dur = Math.min(state.view.dur, d);
  }
  update();
}

function analyze(file) {
  const status = $('waveStatus');
  status.textContent = 'Loading audio engine…';
  let peaks = null;
  let len = 0;
  const job = runWorker({ task: 'analyze', pps: 20, duration: state.duration }, (msg) => {
    if (msg.type === 'probe') {
      if (msg.hasVideo && !state.nativePicture) startFramePreview();
      if (!msg.hasAudio) {
        state.hasAudio = false;
        status.textContent = 'This file has no audio track — there is nothing to export.';
        job.cancel();
        if (!state.duration && msg.duration) setDuration(msg.duration);
        update();
        return;
      }
      if (!state.duration && msg.duration) setDuration(msg.duration);
      status.textContent = 'Building waveform…';
    } else if (msg.type === 'peaks') {
      const need = msg.index + msg.data.length;
      if (!peaks || need > peaks.length) {
        const grown = new Float32Array(Math.max(need, Math.ceil((state.duration || 60) * state.pps) + 1, (peaks ? peaks.length : 0) * 2));
        if (peaks) grown.set(peaks);
        peaks = grown;
      }
      peaks.set(msg.data, msg.index);
      len = need;
      for (const v of msg.data) if (v > state.peakMax) state.peakMax = v;
      state.peaks = peaks;
      state.dirty = true;
      if (!state.duration) status.textContent = `Scanning file… ${fmt(len / state.pps, true)} so far`;
    } else if (msg.type === 'progress' && state.duration) {
      status.textContent = `Building waveform… ${Math.min(99, Math.round(msg.value * 100))}%`;
    }
  });
  state.pps = 20;
  state.analysis = job;
  job.promise.then((msg) => {
    if (state.file !== file) return;
    state.analysis = null;
    status.textContent = '';
    // The decoded length is the most reliable duration (some files lack one).
    if (msg.duration > 0 && (!state.duration || Math.abs(msg.duration - state.duration) > 0.5)) {
      setDuration(msg.duration);
    }
    state.dirty = true;
  }).catch((err) => {
    if (state.file !== file || err.message === 'cancelled') return;
    state.analysis = null;
    console.error(err);
    status.textContent = `Could not read audio: ${err.message}`;
  });
}

// ---------- Editing ----------

function pushHistory() {
  state.history.push(JSON.stringify({ segments: state.segments, selected: state.selected }));
  if (state.history.length > 200) state.history.shift();
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
  if (!splitAt(getPlayhead())) state.history.pop();
  state.selected = segmentIndexAt(getPlayhead());
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
  const t = getPlayhead();
  pushHistory();
  splitAt(t);
  state.segments.forEach((s) => { if (s.end <= t + 1e-9) s.removed = true; });
  state.selected = segmentIndexAt(t);
  update();
}

function trimEnd() {
  const t = getPlayhead();
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
  if (!state.duration || e.target.matches('input, select, textarea')) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const step = e.shiftKey ? 1 : 0.1;
  switch (e.key) {
    case ' ': e.preventDefault(); togglePlay(); break;
    case 's': case 'S': split(); break;
    case 'Delete': case 'Backspace': e.preventDefault(); toggleSelected(); break;
    case '[': trimStart(); break;
    case ']': trimEnd(); break;
    case '+': case '=': zoomBy(0.5); break;
    case '-': case '_': zoomBy(2); break;
    case '0': fitView(); break;
    case 'ArrowLeft': e.preventDefault(); setPlayhead(getPlayhead() - step); break;
    case 'ArrowRight': e.preventDefault(); setPlayhead(getPlayhead() + step); break;
  }
});

// ---------- Playback ----------

function togglePlay() {
  if (!state.videoOK) return;
  if (video.paused) video.play(); else video.pause();
}

$('playBtn').onclick = togglePlay;
video.addEventListener('play', () => { $('playBtn').textContent = 'Pause'; });
video.addEventListener('pause', () => { $('playBtn').textContent = 'Play'; });

// Skip over removed segments while playing.
function skipRemoved() {
  if (!state.videoOK || video.paused || !$('skipCuts').checked || !state.segments.length) return;
  const seg = state.segments[segmentIndexAt(video.currentTime)];
  if (!seg || !seg.removed) return;
  const next = state.segments.find((s) => !s.removed && s.start >= seg.end - 1e-9);
  if (next) video.currentTime = next.start;
  else video.pause();
}

// Keep the playhead visible while playing.
function followPlayhead() {
  if (!state.videoOK || video.paused) return;
  const t = video.currentTime;
  const v = state.view;
  if (t > v.start + v.dur || t < v.start) setView(t - v.dur * 0.05, v.dur);
}

function tick() {
  skipRemoved();
  if (state.duration) {
    followPlayhead();
    updateFramePreview();
    $('timeLabel').textContent = `${fmt(getPlayhead())} / ${fmt(state.duration)}`;
    draw();
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ---------- Timeline view (zoom / scroll) ----------

function setView(start, dur) {
  dur = clamp(dur, Math.min(MIN_VIEW, state.duration), state.duration);
  start = clamp(start, 0, state.duration - dur);
  state.view = { start, dur };
  state.dirty = true;
  const scroll = $('scroll');
  const zoomed = dur < state.duration - 1e-6;
  scroll.hidden = !zoomed;
  scroll.max = String(state.duration - dur);
  scroll.value = String(start);
  $('zoomLabel').textContent = zoomed ? `Showing ${fmt(dur, dur >= 10)}` : 'Whole file';
}

function zoomBy(factor, anchorT) {
  const v = state.view;
  const t = anchorT ?? clamp(getPlayhead(), v.start, v.start + v.dur);
  const frac = (t - v.start) / v.dur;
  const dur = v.dur * factor;
  setView(t - frac * clamp(dur, MIN_VIEW, state.duration), dur);
}

function fitView() { setView(0, state.duration); }

$('zoomInBtn').onclick = () => zoomBy(0.5);
$('zoomOutBtn').onclick = () => zoomBy(2);
$('fitBtn').onclick = fitView;
$('scroll').addEventListener('input', (e) => setView(Number(e.target.value), state.view.dur));

canvas.addEventListener('wheel', (e) => {
  if (!state.duration) return;
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
    const d = e.shiftKey ? e.deltaY : e.deltaX;
    setView(state.view.start + (d / rect.width) * state.view.dur, state.view.dur);
  } else {
    const t = state.view.start + ((e.clientX - rect.left) / rect.width) * state.view.dur;
    zoomBy(Math.exp(e.deltaY * 0.002), t);
  }
}, { passive: false });

// ---------- Timeline drawing ----------

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = layer.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = layer.height = Math.max(1, Math.round(rect.height * dpr));
  setView(state.view.start, state.view.dur);
}
window.addEventListener('resize', () => { if (state.duration) resizeCanvas(); });

const TICKS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];

// Redraws waveform, segments and ruler (only when something changed).
function drawLayer() {
  const g = layerCtx;
  const w = layer.width;
  const h = layer.height;
  const dpr = window.devicePixelRatio || 1;
  const { start, dur } = state.view;
  const pxPerSec = w / dur;
  const toX = (t) => (t - start) * pxPerSec;
  const ruler = 16 * dpr;
  const mid = ruler + (h - ruler) / 2;
  const half = (h - ruler) / 2 - 4 * dpr;

  g.clearRect(0, 0, w, h);

  // Peak level for each pixel column.
  const cols = new Float32Array(w);
  const peaks = state.peaks;
  if (peaks) {
    const pps = state.pps;
    const norm = 1 / state.peakMax;
    for (let x = 0; x < w; x++) {
      const t0 = start + x / pxPerSec;
      const b0 = Math.floor(t0 * pps);
      const b1 = Math.max(b0 + 1, Math.floor((t0 + 1 / pxPerSec) * pps));
      let m = 0;
      for (let b = Math.max(0, b0); b < Math.min(b1, peaks.length); b++) if (peaks[b] > m) m = peaks[b];
      cols[x] = Math.min(1, m * norm);
    }
  }

  state.segments.forEach((s, i) => {
    if (s.end < start || s.start > start + dur) return;
    const x0 = Math.max(0, Math.floor(toX(s.start)));
    const x1 = Math.min(w, Math.ceil(toX(s.end)));
    g.fillStyle = s.removed ? 'rgba(217,83,79,0.18)' : 'rgba(63,178,127,0.10)';
    g.fillRect(x0, ruler, x1 - x0, h - ruler);
    g.fillStyle = s.removed ? 'rgba(217,83,79,0.55)' : '#3fb27f';
    for (let x = x0; x < x1; x++) {
      const amp = Math.max(dpr / 2, cols[x] * half);
      g.fillRect(x, mid - amp, 1, amp * 2);
    }
    if (i === state.selected) {
      g.strokeStyle = '#4f8cff';
      g.lineWidth = 2 * dpr;
      g.strokeRect(toX(s.start) + dpr, ruler + dpr, toX(s.end) - toX(s.start) - 2 * dpr, h - ruler - 2 * dpr);
    }
    if (i > 0) {
      g.fillStyle = '#e6e8ee';
      g.fillRect(toX(s.start) - dpr / 2, ruler, dpr, h - ruler);
    }
  });

  // Time ruler.
  const step = TICKS.find((s) => s * pxPerSec >= 90 * dpr) || 7200;
  g.fillStyle = '#9aa1b1';
  g.font = `${11 * dpr}px system-ui, sans-serif`;
  g.textBaseline = 'top';
  for (let t = Math.ceil(start / step) * step; t <= start + dur; t += step) {
    const x = toX(t);
    g.fillRect(x, 0, dpr, 5 * dpr);
    g.fillText(fmt(t, step >= 1), x + 3 * dpr, 2 * dpr);
  }
  g.fillRect(0, ruler - dpr, w, dpr);
}

function draw() {
  if (state.dirty) {
    drawLayer();
    state.dirty = false;
  }
  const dpr = window.devicePixelRatio || 1;
  ctx2d.clearRect(0, 0, canvas.width, canvas.height);
  ctx2d.drawImage(layer, 0, 0);
  const px = (getPlayhead() - state.view.start) * (canvas.width / state.view.dur);
  ctx2d.fillStyle = '#ffcc33';
  ctx2d.fillRect(px - dpr, 0, 2 * dpr, canvas.height);
}

canvas.addEventListener('pointerdown', (e) => {
  if (!state.duration) return;
  const rect = canvas.getBoundingClientRect();
  const seek = (ev) => {
    const t = state.view.start + clamp((ev.clientX - rect.left) / rect.width, 0, 1) * state.view.dur;
    setPlayhead(t);
    return t;
  };
  const t = seek(e);
  state.selected = segmentIndexAt(t);
  state.dirty = true;
  update();
  canvas.setPointerCapture(e.pointerId);
  canvas.onpointermove = seek;
  canvas.onpointerup = () => { canvas.onpointermove = null; };
});

// ---------- Segment list ----------

function renderList() {
  $('segmentList').innerHTML = state.segments.map((s, i) => `
    <tr data-i="${i}" class="${s.removed ? 'removed' : ''} ${i === state.selected ? 'selected' : ''}">
      <td>${i + 1}</td><td>${fmt(s.start)}</td><td>${fmt(s.end)}</td>
      <td>${fmt(s.end - s.start)}</td><td>${s.removed ? 'Removed' : 'Kept'}</td>
    </tr>`).join('');
}

$('segmentList').addEventListener('click', (e) => {
  const row = e.target.closest('tr');
  if (!row) return;
  state.selected = Number(row.dataset.i);
  const seg = state.segments[state.selected];
  setPlayhead(seg.start);
  if (seg.start < state.view.start || seg.start > state.view.start + state.view.dur) {
    setView(seg.start - state.view.dur * 0.05, state.view.dur);
  }
  update();
});

function update() {
  state.dirty = true;
  renderList();
  const kept = keptSegments().length;
  $('summary').textContent = !state.hasAudio ? 'No audio track in this file.' : kept
    ? `Output length: ${fmt(keptDuration())} from ${kept} kept segment${kept === 1 ? '' : 's'} (original ${fmt(state.duration)}).`
    : 'Everything is removed — restore a segment to export.';
  $('exportBtn').disabled = kept === 0 || !state.hasAudio || !!state.exporting;
  $('undoBtn').disabled = state.history.length === 0;
  const seg = state.segments[state.selected];
  $('toggleBtn').textContent = seg && seg.removed ? 'Restore segment' : 'Remove segment';
}

// ---------- Export ----------

$('format').addEventListener('change', () => {
  $('bitrateLabel').hidden = $('format').value !== 'mp3';
});

function wavHeader(dataBytes, rate, channels) {
  const size = Math.min(dataBytes, WAV_LIMIT);
  const v = new DataView(new ArrayBuffer(44));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + size, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, channels, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * channels * 2, true); v.setUint16(32, channels * 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, size, true);
  return new Uint8Array(v.buffer);
}

// Where exported bytes go. Normal-sized exports are collected and downloaded
// at the end; very large ones stream straight to a file on disk when the
// browser allows it (Chrome/Edge).
async function openOutput(name, ext, estimatedBytes, onFail) {
  if (window.showSaveFilePicker && estimatedBytes > DIRECT_SAVE_OVER) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: name,
        types: [{ description: `${ext.toUpperCase()} audio`, accept: { [ext === 'mp3' ? 'audio/mpeg' : 'audio/wav']: [`.${ext}`] } }],
      });
      const writable = await handle.createWritable();
      let chain = Promise.resolve();
      let failed = null;
      return {
        write: (bytes) => {
          chain = chain.then(() => failed || writable.write(bytes)).catch((err) => {
            if (!failed) { failed = err; onFail(err); }
          });
        },
        finish: async (header) => {
          await chain;
          if (failed) throw failed;
          if (header) await writable.write({ type: 'write', position: 0, data: header });
          await writable.close();
        },
        abort: () => { chain.then(() => writable.abort()).catch(() => {}); },
      };
    } catch (err) {
      if (err.name === 'AbortError') return null; // user cancelled the dialog
      console.warn('Save dialog unavailable, falling back to download', err);
    }
  }
  const parts = [];
  return {
    write: (bytes) => { parts.push(new Blob([bytes])); },
    finish: async (header) => {
      if (header) parts[0] = new Blob([header]);
      const blob = new Blob(parts, { type: ext === 'mp3' ? 'audio/mpeg' : 'audio/wav' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    },
    abort: () => { parts.length = 0; },
  };
}

$('exportBtn').onclick = async () => {
  const format = $('format').value;
  const segments = keptSegments().map(({ start, end }) => ({ start, end }));
  const total = keptDuration();
  if (format === 'wav' && total * OUT_RATE * 4 > WAV_LIMIT) {
    $('exportStatus').textContent = `WAV files can't be larger than 4 GB (about 6.7 hours). Use MP3 for this length.`;
    return;
  }
  const name = `${baseName(state.file.name)}_edited.${format}`;
  let job = null;
  let writeError = null;
  const estimate = total * (format === 'wav' ? OUT_RATE * 4 : Number($('bitrate').value) * 125);
  const out = await openOutput(name, format, estimate, (err) => {
    writeError = err;
    if (job) job.cancel();
  });
  if (!out) return;

  const status = $('exportStatus');
  const bar = $('exportProgress');
  let written = 0;
  if (format === 'wav') { out.write(new Uint8Array(44)); }

  job = runWorker({ task: 'export', segments, format, kbps: Number($('bitrate').value), rate: OUT_RATE }, (msg) => {
    if (msg.type === 'data') {
      written += msg.bytes.length;
      out.write(msg.bytes);
    } else if (msg.type === 'progress') {
      bar.value = Math.min(1, msg.value);
      status.textContent = `Exporting… ${Math.min(99, Math.round(msg.value * 100))}% (${fmtBytes(written)})`;
    }
  });
  state.exporting = job;
  bar.hidden = false;
  bar.removeAttribute('value');
  $('cancelBtn').hidden = false;
  status.textContent = 'Loading audio engine…';
  update();

  try {
    await job.promise;
    status.textContent = 'Saving…';
    await out.finish(format === 'wav' ? wavHeader(written, OUT_RATE, 2) : null);
    status.textContent = `Done — ${name}, ${fmtBytes(written + (format === 'wav' ? 44 : 0))}`;
  } catch (err) {
    out.abort();
    console.error(err);
    if (writeError) err = new Error(`could not write the file (${writeError.message})`);
    status.textContent = err.message === 'cancelled' ? 'Export cancelled.' : `Export failed: ${err.message}`;
  } finally {
    state.exporting = null;
    bar.hidden = true;
    $('cancelBtn').hidden = true;
    update();
  }
};

$('cancelBtn').onclick = () => {
  if (!state.exporting) return;
  state.exporting.cancel();
};
