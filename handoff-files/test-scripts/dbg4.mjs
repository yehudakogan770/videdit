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
      for (const args of [data.runs[data.i]]) { const logs = []; c.setLogger(m => logs.push(m.message)); let err = null;
        try { c.exec(...args); } catch (e) { err = String(e); } const ret = c.ret; c.reset(); res.push({ ret, err, logs: logs.slice(-6) }); }
      postMessage(res); };`;
  const B = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/';
  const f = (t, extra) => ['-hide_banner', '-nostdin', '-ss', String(t), '-i', '/mnt/input', '-map', '0:v:0', '-frames:v', '1', ...extra, '-y', '/frame.out'];
  const runs = [f(0, ['-q:v', '4', '-f', 'mjpeg']), f(10, ['-f', 'image2', '-c:v', 'png']), f(20, ['-vf', 'scale=320:-2', '-pix_fmt', 'rgba', '-f', 'rawvideo']), f(30, ['-f', 'image2', '-c:v', 'bmp']), f(5, ['-f', 'null']), f(0, ['-threads','1','-f', 'null'])];
  const all = [];
  for (let i = 0; i < runs.length; i++) {
    const w = new Worker(URL.createObjectURL(new Blob([src])));
    w.postMessage({ u: B + 'ffmpeg-core.js', w: B + 'ffmpeg-core.wasm', file, runs, i });
    all.push(...await new Promise(res => w.onmessage = e => res(e.data)));
    w.terminate();
  }
  return all;
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
