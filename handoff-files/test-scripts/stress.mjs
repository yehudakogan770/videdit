import { chromium } from 'playwright-core';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--ignore-certificate-errors'] });
const page = await browser.newPage();
page.on('pageerror', e => console.log('pageerror:', e.message));
await page.goto('file:///home/user/videdit/index.html');
await page.evaluate(() => { window.showOpenFilePicker = undefined; });
const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('#importBtn')]);
await fc.setFiles(['h264_opus.mp4']);
await page.waitForFunction(() => frames.worker && document.getElementById('frameImg').naturalWidth > 0, null, { timeout: 60000 });
// Simulate playback: walk the playhead forward 0.2s at a time, like playing.
const res = await page.evaluate(async () => {
  let updates = 0, lastSrc = '', stuckAt = null, log = [];
  const t0 = performance.now();
  let maxWait = 0; for (let k = 0; k < 944; k++) { const t = (k * 0.25) % 118;
    state.playhead = t; if (state.videoOK) video.currentTime = t;
    const start = performance.now();
    while (frames.busy || Math.abs(frames.shownT - t) > 0.05) { await new Promise(r => setTimeout(r, 10)); if (performance.now() - start > 5000) { stuckAt = t; break; } }
    if (stuckAt !== null) break;
    await new Promise(r => setTimeout(r, 20));
    const src = document.getElementById('frameImg').src;
    if (src !== lastSrc) updates++; else log.push(t); maxWait = Math.max(maxWait, Math.round(performance.now() - start));
    lastSrc = src;
  }
  return { updates, stuckAt, noUpdateAt: log.slice(0, 10), noUpdates: log.length, failures: frames.failures, maxWait, ms: Math.round(performance.now() - t0), loading: document.getElementById('frameLoading').textContent, loadingShown: !document.getElementById('frameLoading').hidden };
});
console.log(res);
await browser.close();
