import { chromium } from 'playwright-core';
import fs from 'fs';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--ignore-certificate-errors'] });
const page = await browser.newPage();
await page.goto('file:///home/user/videdit/index.html');
for (const [name, acodec] of [['h264_aac.mp4', 'aac'], ['h264_opus.mp4', 'libopus']]) {
  const b64 = await page.evaluate(async ({ name, acodec }) => {
    const src = `importScripts('https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.js');
      onmessage = async ({data}) => { const c = await createFFmpegCore({ mainScriptUrlOrBlob: data.u + '#' + btoa(JSON.stringify({ wasmURL: data.w })) });
        const logs = []; c.setLogger(m => logs.push(m.message));
        c.exec(...data.args); const ret = c.ret;
        let out = null; try { out = c.FS.readFile('/o.mp4'); } catch (e) {}
        postMessage({ ret, out, logs: logs.slice(-5) }); };`;
    const w = new Worker(URL.createObjectURL(new Blob([src])));
    const B = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/';
    w.postMessage({ u: B + 'ffmpeg-core.js', w: B + 'ffmpeg-core.wasm', args: ['-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25:duration=120', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=120',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '250', '-c:a', acodec, '-b:a', '96k', '-shortest', '/o.mp4'] });
    const r = await new Promise(res => w.onmessage = e => res(e.data));
    if (!r.out) return 'ERR ' + r.ret + ' ' + r.logs.join(' | ');
    let s = ''; for (let i = 0; i < r.out.length; i += 0x8000) s += String.fromCharCode(...r.out.subarray(i, i + 0x8000)); return btoa(s);
  }, { name, acodec });
  if (b64.startsWith('ERR')) { console.log(name, b64); continue; }
  fs.writeFileSync(name, Buffer.from(b64, 'base64'));
  console.log(name, fs.statSync(name).size);
}
await browser.close();
