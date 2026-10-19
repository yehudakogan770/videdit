import { chromium } from 'playwright-core';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--ignore-certificate-errors'] });
const page = await browser.newPage();
page.on('pageerror', e => console.log('pageerror:', e.message));
await page.goto('file:///tmp/claude-0/-home-user-videdit/824980e8-c668-5c2c-8ba3-97df4986d406/scratchpad/VidEdit.html');
for (const f of ['h264_aac.mp4', 'h264_opus.mp4', 'test.webm']) {
  await page.setInputFiles('#fileInput', f);
  await page.waitForSelector('#editor:not([hidden])', { timeout: 60000 });
  await page.waitForTimeout(500);
  const info = await page.evaluate(() => ({ videoOK: state.videoOK, native: state.nativePicture, videoShown: !document.getElementById('video').hidden, frameShown: !document.getElementById('framePreview').hidden }));
  let t0 = Date.now();
  if (info.frameShown) {
    await page.waitForFunction(() => document.getElementById('frameImg').naturalWidth > 0, null, { timeout: 60000 });
    console.log(f, info, 'first frame after', Date.now() - t0, 'ms');
    // Jump and time a frame update.
    const before = await page.evaluate(() => document.getElementById('frameImg').src);
    await page.evaluate(() => setPlayhead(75.5));
    t0 = Date.now();
    await page.waitForFunction((b) => document.getElementById('frameImg').src !== b && frames.shownT === 75.5 && !frames.busy, before, { timeout: 30000 });
    console.log('  seek frame after', Date.now() - t0, 'ms');
    await page.screenshot({ path: `shot-${f}.png` });
  } else console.log(f, info);
}
await browser.close();
