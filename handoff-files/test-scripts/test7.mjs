import { chromium } from 'playwright-core';
import fs from 'fs';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--ignore-certificate-errors'] });
const ctx = await browser.newContext({ acceptDownloads: true });
const page = await ctx.newPage();
page.on('pageerror', e => console.log('pageerror:', e.message));
page.on('dialog', d => { console.log('dialog:', d.message().split('\n')[0]); d.accept(); });
const clips = () => page.$$eval('#clipList .clip', els => els.map(e => (e.classList.contains('active') ? '*' : '') + e.querySelector('.clip-name').textContent + ' [' + e.querySelector('.clip-meta').textContent + ']'));

// ---- Part 1: plain file input ----
await page.goto('http://localhost:8765/index.html');
await page.evaluate(() => { window.showOpenFilePicker = undefined; });
const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('#importBtn')]);
await fc.setFiles(['test.webm', 'h264_opus.mp4', 'h264_aac.mp4']);
await page.waitForSelector('#editor:not([hidden])');
await page.waitForFunction(() => state.clips[0].duration && state.clips[1].duration);
console.log('list:', await clips());
// Cut clip 1: remove 1s..2s
await page.evaluate(() => setPlayhead(1)); await page.keyboard.press('s');
await page.evaluate(() => setPlayhead(2)); await page.keyboard.press('s');
await page.click('#segmentList tr:nth-child(2)'); await page.keyboard.press('Delete');
console.log('clip1:', await page.textContent('#summary'));
// Switch to clip 3 and back
await page.click('#clipList .clip:nth-child(3) .clip-open');
await page.waitForFunction(() => state.clip === state.clips[2]);
console.log('clip3:', await page.textContent('#summary'), await page.textContent('#fileName'));
await page.click('#clipList .clip:nth-child(1) .clip-open');
await page.waitForFunction(() => state.clip === state.clips[0]);
console.log('back to clip1:', await page.textContent('#summary'));
// Export clip 1
await page.selectOption('#format', 'wav');
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#exportBtn')]);
await dl.saveAs('o7.wav');
await page.waitForSelector('#finishBox:not([hidden])');
console.log('exported', dl.suggestedFilename(), fs.statSync('o7.wav').size, '| delete btn hidden:', await page.$eval('#deleteDoneBtn', b => b.hidden), '| note:', await page.textContent('#finishNote'));
console.log('list:', await clips());
await page.click('#removeDoneBtn');
await page.waitForTimeout(500);
console.log('after remove:', await clips(), '| finish hidden:', await page.$eval('#finishBox', b => b.hidden));

// ---- Part 2: file handles (OPFS stand-in) + delete original ----
const page2 = await ctx.newPage();
page2.on('pageerror', e => console.log('pageerror2:', e.message));
page2.on('dialog', d => { console.log('dialog:', d.message().split('\n')[0]); d.accept(); });
await page2.goto('http://localhost:8765/index.html');
const b64 = fs.readFileSync('h264_opus.mp4').toString('base64');
await page2.evaluate(async (b64) => {
  const root = await navigator.storage.getDirectory();
  for (const n of ['lecture1.mp4', 'lecture2.mp4']) {
    const h = await root.getFileHandle(n, { create: true });
    const w = await h.createWritable(); await w.write(Uint8Array.from(atob(b64), c => c.charCodeAt(0))); await w.close();
  }
  window.showOpenFilePicker = async () => Promise.all(['lecture1.mp4', 'lecture2.mp4'].map(n => root.getFileHandle(n)));
}, b64);
await page2.click('#importBtn');
await page2.waitForSelector('#editor:not([hidden])');
await page2.evaluate(() => setPlayhead(100)); await page2.keyboard.press(']');
const [dl2] = await Promise.all([page2.waitForEvent('download'), page2.click('#exportBtn')]);
await page2.waitForSelector('#finishBox:not([hidden])');
console.log('exported', dl2.suggestedFilename(), '| delete btn visible:', !(await page2.$eval('#deleteDoneBtn', b => b.hidden)));
await page2.click('#deleteDoneBtn');
await page2.waitForFunction(() => state.clips.length === 1, null, { timeout: 10000 });
const left = await page2.evaluate(async () => { const r = []; for await (const [n] of (await navigator.storage.getDirectory()).entries()) r.push(n); return r; });
console.log('files left on disk:', left, '| list:', await page2.$$eval('#clipList .clip-name', e => e.map(x => x.textContent)), '| status:', await page2.textContent('#exportStatus'));
await page2.waitForFunction(() => state.clip && state.clip.duration > 0);
console.log('now editing:', await page2.textContent('#fileName'));
await browser.close();
