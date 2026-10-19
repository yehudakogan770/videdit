import { chromium } from 'playwright-core';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--ignore-certificate-errors'] });
const page = await browser.newPage();
await page.goto('file:///home/user/videdit/index.html');
await page.setInputFiles('#fileInput', 'h264_aac.mp4');
const out = await page.evaluate(async () => {
  const file = state.file;
  const src = `importScripts('https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.js');
    onmessage = async ({data}) => { const c = await createFFmpegCore({ mainScriptUrlOrBlob: data.u + '#' + btoa(JSON.stringify({ wasmURL: data.w })) });
      c.FS.mkdir('/mnt'); c.FS.mount(c.FS.filesystems.WORKERFS, { blobs: [{ name: 'input', data: data.file }] }, '/mnt');
      const res = [];
      for (const args of data.runs) { const logs = []; c.setLogger(m => logs.push(m.message)); let err = null; const t0 = performance.now();
        try { c.exec(...args); logs.push('ms ' + Math.round(performance.now() - t0)); } catch (e) { err = String(e); } const ret = c.ret; c.reset(); res.push({ ret, err, logs: logs.slice(-6) }); }
      postMessage(res); };`;
  const w = new Worker(URL.createObjectURL(new Blob([src])));
  const B = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/';
  const f = (t, extra) => ['-hide_banner', '-nostdin', '-ss', String(t), '-i', '/mnt/input', '-map', '0:v:0', '-frames:v', '1', ...extra, '-f', 'image2', '-c:v', 'png', '-compression_level', '1', '-y', '/frame.png'];
  w.postMessage({ u: B + 'ffmpeg-core.js', w: B + 'ffmpeg-core.wasm', file, runs: [f(0, []), f(10, ['-vf', 'scale=w=960:h=540:force_original_aspect_ratio=decrease']), f(99.5, []), f(3, [])] });
  return await new Promise(res => w.onmessage = e => res(e.data));
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
