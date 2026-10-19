import { chromium } from 'playwright-core';
import fs from 'fs';
import { execSync } from 'child_process';
const rss = () => Math.round(Number(execSync("ps -eo rss,comm | grep -i chrom | awk '{s+=$1} END {print s}'").toString()) / 1024);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--ignore-certificate-errors'] });
const page = await browser.newPage({ acceptDownloads: true });
page.on('pageerror', e => console.log('pageerror:', e.message));
// Stub the save dialog with an OPFS file.
await page.addInitScript(() => {
  // Counting sink: records size, header and a few samples at known offsets.
  window.saved = {};
  window.showSaveFilePicker = async ({ suggestedName }) => ({ createWritable: async () => {
    const rec = window.saved[suggestedName] = { size: 0, probes: {}, header: null };
    let pos = 0;
    return {
      async write(d) {
        if (window.failAfter && pos > window.failAfter) throw new Error('disk full');
        if (d.type === 'write') { rec.header = Array.from(d.data); return; }
        for (const off of window.probeOffsets || []) if (off >= pos && off + 2 <= pos + d.length) rec.probes[off] = (d[off - pos] | d[off - pos + 1] << 8) << 16 >> 16;
        pos += d.length; rec.size = Math.max(rec.size, pos);
      },
      async close() { rec.closed = true; }, async abort() { rec.aborted = true; },
    };
  } });
});
await page.goto('http://localhost:8765/index.html');

// webm length check with padding (blob path not used here; check via OPFS)
async function run(file, keep, format, name) {
  await page.setInputFiles('#fileInput', file);
  await page.waitForSelector('#editor:not([hidden])');
  await page.evaluate(({ keep, format }) => {
    state.segments = []; let t = 0;
    for (const [a, b] of keep) { if (a > t) state.segments.push({ start: t, end: a, removed: true }); state.segments.push({ start: a, end: b, removed: false }); t = b; }
    if (t < state.duration) state.segments.push({ start: t, end: state.duration, removed: true });
    update(); document.getElementById('format').value = format;
  }, { keep, format });
  const t0 = Date.now(); let peak = 0;
  await page.click('#exportBtn');
  await page.waitForTimeout(200);
  while (await page.evaluate(() => !!state.exporting)) { peak = Math.max(peak, rss()); await page.waitForTimeout(1000); }
  const size = await page.evaluate((n) => window.saved[n] && window.saved[n].size, name);
  console.log(`${file} → ${format}: ${size} bytes, ${((Date.now() - t0) / 1000).toFixed(1)}s, peak RSS ${peak} MB — ${await page.textContent('#exportStatus')}`);
  return size;
}
const sec = (t) => 44 + Math.round((t + 0.5) * 44100) * 4;
await page.evaluate((o) => { window.probeOffsets = o; }, [sec(0), sec(3600), sec(7199)]);
await run('huge.rf64.wav', [[1000, 8200]], 'wav', 'huge.rf64_edited.wav');
let r = await page.evaluate(() => window.saved['huge.rf64_edited.wav']);
const hv = Buffer.from(r.header);
console.log('  size', r.size, 'expected', 7200 * 176400 + 44, 'closed', r.closed, 'header data size', hv.readUInt32LE(40));
console.log('  samples', Object.values(r.probes), 'want', [1000, 4600, 8199].map(s => (s % 1000) * 30 - 15000));
await run('huge.rf64.wav', [[0, 18000]], 'mp3', 'huge.rf64_edited.mp3');
r = await page.evaluate(() => window.saved['huge.rf64_edited.mp3']);
console.log('  mp3 size', r.size, 'expected ~', 18000 * 192000 / 8);
await page.evaluate(() => { window.failAfter = 5e6; });
await run('huge.rf64.wav', [[0, 600]], 'wav', 'huge.rf64_edited.wav');
await browser.close();
