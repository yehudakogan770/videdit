// End-to-end test: drives the real page in Chromium with Playwright.
//
//   npm install && npm test            (or: node tests/e2e.mjs)
//
// Env:
//   CHROMIUM_PATH   Chromium/Chrome executable (default: /opt/pw-browsers/chromium,
//                   the browser preinstalled in Claude Code cloud sessions)
//   PAGE            'src' (default) tests index.html; 'dist' builds and tests dist/VidEdit.html
//   LONG=1          also run the frame-preview stress test (~2.5 minutes)
//
// Needs internet: the page loads the ffmpeg engine from cdn.jsdelivr.net.
// Note: Playwright's Chromium cannot play H.264/AAC (no proprietary codecs), which
// is exactly what we need to exercise the "browser can't show the picture" path.

import { chromium } from 'playwright-core';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixtures = path.join(root, 'tests', 'fixtures');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'videdit-e2e-'));
let failures = 0;

function check(cond, msg) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures++;
}

// Generated WAV: 120 s, each second a distinct constant value (see gen_wav.py).
const toneWav = path.join(tmp, 'tone.wav');
execFileSync('python3', [path.join(root, 'tests', 'gen_wav.py'), toneWav, '120']);
const valAt = (sec) => (sec % 1000) * 30 - 15000;

let pageURL = `file://${path.join(root, 'index.html')}`;
if (process.env.PAGE === 'dist') {
  execFileSync('python3', [path.join(root, 'tools', 'build_single_file.py')], { stdio: 'inherit' });
  pageURL = `file://${path.join(root, 'dist', 'VidEdit.html')}`;
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
  // Cloud sessions reach the CDN through a TLS-inspecting proxy; test-only flag.
  args: ['--ignore-certificate-errors'],
});
const page = await browser.newPage({ acceptDownloads: true });
page.on('pageerror', (e) => { console.log('pageerror:', e.message); failures++; });
page.on('dialog', (d) => d.accept());
await page.goto(pageURL);
// Use the plain file input (Playwright can't drive showOpenFilePicker).
await page.evaluate(() => { window.showOpenFilePicker = undefined; });

const clipNames = () => page.$$eval('#clipList .clip-name', (els) => els.map((e) => e.textContent));
const activeName = () => page.$eval('#clipList .clip.active .clip-name', (e) => e.textContent);

// 1. Import several videos at once.
const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#importBtn')]);
await chooser.setFiles([toneWav, path.join(fixtures, 'test.webm'), path.join(fixtures, 'h264_opus.mp4')]);
await page.waitForSelector('#editor:not([hidden])');
check((await clipNames()).length === 3, 'three videos in the list');
check((await activeName()) === 'tone.wav', 'first video opens');

// 2. Cut with the keyboard: keep 10–13 s and 50–52 s.
await page.waitForFunction(() => state.duration > 0);
const cut = async (t, key) => { await page.evaluate((t) => setPlayhead(t), t); await page.keyboard.press(key); };
await cut(10, '[');
await cut(13, 's');
await cut(50, 's');
await cut(52, ']');
// Segment 13–50 is still kept: select it and remove it.
const idx = await page.evaluate(() => state.segments.findIndex((s) => Math.abs(s.start - 13) < 1e-6));
await page.click(`#segmentList tr:nth-child(${idx + 1})`);
await page.keyboard.press('Delete');
check((await page.textContent('#summary')).includes('0:05.00'), 'output length is 5 s');

// 3. Export WAV and verify it sample by sample.
async function exportAs(format, file) {
  await page.selectOption('#format', format);
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.click('#exportBtn')]);
  await dl.saveAs(file);
  return dl.suggestedFilename();
}
const outWav = path.join(tmp, 'out.wav');
check((await exportAs('wav', outWav)) === 'tone_edited.wav', 'WAV download name');
{
  const data = fs.readFileSync(outWav).subarray(44);
  const frames = data.length / 4;
  check(frames === 5 * 44100, `WAV has exactly 5 s of samples (${frames})`);
  const kept = [10, 11, 12, 50, 51];
  const ok = kept.every((sec, i) => data.readInt16LE(Math.round((i + 0.5) * 44100) * 4) === valAt(sec));
  check(ok, 'WAV content comes from the kept seconds, in order');
}

// 4. Export MP3 (192 kbps ≈ 24 KB per second).
const outMp3 = path.join(tmp, 'out.mp3');
await exportAs('mp3', outMp3);
const mp3Size = fs.statSync(outMp3).size;
check(mp3Size > 100000 && mp3Size < 140000, `MP3 size plausible (${mp3Size} bytes)`);
check(!(await page.$eval('#finishBox', (b) => b.hidden)), 'finish box shows after export');

// 5. Switch to the H.264 video: picture comes from ffmpeg frames.
await page.click('#clipList .clip:nth-child(3) .clip-open');
await page.waitForFunction(() => document.getElementById('frameImg').naturalWidth > 0, null, { timeout: 60000 });
check(await page.evaluate(() => !state.nativePicture && !document.getElementById('framePreview').hidden), 'frame preview used for H.264');
const before = await page.$eval('#frameImg', (i) => i.src);
await page.evaluate(() => setPlayhead(75.5));
await page.waitForFunction((b) => document.getElementById('frameImg').src !== b, before, { timeout: 15000 });
check(true, 'frame updates after moving the playhead');

// 6. Back to the WAV: cuts are still there.
await page.click('#clipList .clip:nth-child(1) .clip-open');
await page.waitForFunction(() => state.clip === state.clips[0]);
check((await page.textContent('#summary')).includes('0:05.00'), 'cuts kept when switching videos');

// 7. Remove from list → next video opens.
await page.click('#removeDoneBtn');
await page.waitForFunction(() => state.clips.length === 2 && state.clip);
check((await clipNames()).join(',') === 'test.webm,h264_opus.mp4', 'removed from list, others remain');
check((await activeName()) === 'test.webm', 'next video opened');

// 8. Optional: frame preview survives long playback (engine rotation).
if (process.env.LONG) {
  await page.click('#clipList .clip:nth-child(2) .clip-open');
  await page.waitForFunction(() => document.getElementById('frameImg').naturalWidth > 0, null, { timeout: 60000 });
  const res = await page.evaluate(async () => {
    let updates = 0;
    let last = '';
    for (let k = 0; k < 600; k++) {
      const t = (k * 0.25) % 118;
      setPlayhead(t);
      const start = performance.now();
      while (frames.busy || Math.abs(frames.shownT - t) > 0.05) {
        await new Promise((r) => setTimeout(r, 10));
        if (performance.now() - start > 5000) return { updates, stuckAt: t };
      }
      await new Promise((r) => setTimeout(r, 20));
      const src = document.getElementById('frameImg').src;
      if (src !== last) updates++;
      last = src;
    }
    return { updates, failures: frames.failures };
  });
  check(res.updates === 600 && !res.stuckAt, `600 frames in a row without freezing (${JSON.stringify(res)})`);
}

await browser.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
