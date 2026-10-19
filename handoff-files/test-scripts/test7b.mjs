import { chromium } from 'playwright-core';
import fs from 'fs';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--ignore-certificate-errors'] });
const ctx = await browser.newContext({ acceptDownloads: true });
const page = await ctx.newPage();
page.on('pageerror', e => console.log('pageerror:', e.message));
page.on('dialog', d => { console.log('dialog:', d.message().split('\n')[0]); d.accept(); });
const clips = () => page.$$eval('#clipList .clip', els => els.map(e => (e.classList.contains('active') ? '*' : '') + e.querySelector('.clip-name').textContent + ' [' + e.querySelector('.clip-meta').textContent + ']'));

// ---- Part 1: plain file input ----
await page.goto('file:///tmp/claude-0/-home-user-videdit/824980e8-c668-5c2c-8ba3-97df4986d406/scratchpad/VidEdit.html');
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

await browser.close();
