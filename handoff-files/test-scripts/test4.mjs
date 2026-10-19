import { chromium } from 'playwright-core';
import fs from 'fs';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--ignore-certificate-errors'] });
const page = await browser.newPage({ acceptDownloads: true });
page.on('pageerror', e => console.log('pageerror:', e.message));
await page.goto('file:///home/user/videdit/index.html');
console.log('save picker available:', await page.evaluate(() => !!window.showSaveFilePicker));
await page.setInputFiles('#fileInput', 'big.wav');
await page.waitForSelector('#editor:not([hidden])');
// Cut via the UI: keep 10 minutes starting at 1:00:00.
await page.evaluate(() => setPlayhead(3600)); await page.keyboard.press('[');
await page.evaluate(() => setPlayhead(4200)); await page.keyboard.press(']');
console.log(await page.textContent('#summary'));
await page.selectOption('#format', 'mp3');
const t0 = Date.now();
const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.click('#exportBtn')]);
await dl.saveAs('o4.mp3');
console.log(dl.suggestedFilename(), fs.statSync('o4.mp3').size, 'bytes in', ((Date.now() - t0) / 1000).toFixed(1), 's —', await page.textContent('#exportStatus'));
await browser.close();
