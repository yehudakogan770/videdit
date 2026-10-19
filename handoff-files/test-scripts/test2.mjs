import { chromium } from 'playwright-core';
import fs from 'fs';
import { execSync } from 'child_process';
const rss = () => Math.round(Number(execSync("ps -eo rss,comm | grep -i chrom | awk '{s+=$1} END {print s}'").toString()) / 1024);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--ignore-certificate-errors'] });
const ctx = await browser.newContext({ acceptDownloads: true });
const page = await ctx.newPage();
page.on('pageerror', e => console.log('pageerror:', e.message));
page.on('console', m => { if (m.type() === 'error') console.log('console:', m.text()); });

async function waitWave(label) {
  const t0 = Date.now();
  let peak = 0;
  while (true) {
    const st = await page.evaluate(() => ({ s: document.getElementById('waveStatus').textContent, a: !!state.analysis, d: state.duration }));
    peak = Math.max(peak, rss());
    if (!st.a && st.d) break;
    await page.waitForTimeout(1000);
  }
  console.log(`${label}: waveform done in ${((Date.now() - t0) / 1000).toFixed(1)}s, duration ${await page.evaluate(() => state.duration)}, peak browser RSS ${peak} MB`);
}

async function cutAndExport(keep, format, file) {
  await page.evaluate(({ keep, format }) => {
    state.segments = [];
    let t = 0;
    for (const [a, b] of keep) { if (a > t) state.segments.push({ start: t, end: a, removed: true }); state.segments.push({ start: a, end: b, removed: false }); t = b; }
    if (t < state.duration) state.segments.push({ start: t, end: state.duration, removed: true });
    update();
    document.getElementById('format').value = format;
  }, { keep, format });
  const t0 = Date.now();
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 600000 }), page.click('#exportBtn')]);
  await dl.saveAs(file);
  console.log(`  export ${format}: ${fs.statSync(file).size} bytes in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${await page.textContent('#exportStatus')}`);
}

function checkWav(file, keep) {
  const b = fs.readFileSync(file);
  const data = b.subarray(44);
  const frames = data.length / 4;
  const expect = keep.reduce((n, [a, c]) => n + (c - a), 0) * 44100;
  let pos = 0, ok = true;
  for (const [a, c] of keep) {
    for (let s = a; s < c; s++) {
      const mid = pos + Math.round((s - a + 0.5) * 44100);
      const v = data.readInt16LE(mid * 4);
      const want = (s % 1000) * 30 - 15000;
      if (Math.abs(v - want) > 2) { ok = false; console.log(`   mismatch at src ${s}s: got ${v}, want ${want}`); break; }
    }
    pos += (c - a) * 44100;
  }
  console.log(`  verify: ${frames} frames (expected ${expect}, diff ${frames - expect}), content ${ok ? 'OK' : 'BAD'}`);
}

// Blob fallback path for downloads in tests.
await page.addInitScript(() => { delete window.showSaveFilePicker; });

// 1) Small real video over file://
await page.goto('file:///home/user/videdit/index.html');
await page.setInputFiles('#fileInput', 'test.webm');
await waitWave('webm');
await page.screenshot({ path: 'shot-webm.png', fullPage: true });
await cutAndExport([[0, 1], [2, 3]], 'wav', 'o1.wav');
await cutAndExport([[0, 1], [2, 3]], 'mp3', 'o1.mp3');

// 2) 2.3 GB WAV
let t0 = Date.now();
await page.setInputFiles('#fileInput', 'big.wav');
await page.waitForSelector('#editor:not([hidden])', { timeout: 60000 });
console.log(`big.wav: editor ready in ${((Date.now() - t0) / 1000).toFixed(1)}s, videoOK=${await page.evaluate(() => state.videoOK)}`);
await waitWave('big.wav');
await page.screenshot({ path: 'shot-big.png', fullPage: true });
const k2 = [[100, 110], [7000, 7005], [12990, 13000]];
await cutAndExport(k2, 'wav', 'o2.wav'); checkWav('o2.wav', k2);

// 3) 5.3 GB RF64 (reads past 4 GB; browser can't preview it)
t0 = Date.now();
await page.setInputFiles('#fileInput', 'huge.rf64.wav');
await page.waitForSelector('#editor:not([hidden])', { timeout: 120000 });
console.log(`huge: editor ready in ${((Date.now() - t0) / 1000).toFixed(1)}s, videoOK=${await page.evaluate(() => state.videoOK)}`);
const k3 = [[16000, 16003], [29990, 30000]];
await cutAndExport(k3, 'wav', 'o3.wav'); checkWav('o3.wav', k3);
await waitWave('huge');
await page.evaluate(() => { setView(29980, 30); });
await page.waitForTimeout(300);
await page.screenshot({ path: 'shot-huge.png', fullPage: true });
await browser.close();
