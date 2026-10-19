import { chromium } from 'playwright-core';
import fs from 'fs';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ acceptDownloads: true });
await page.route('**/lame.min.js', r => r.fulfill({ path: 'lame.min.js', contentType: 'text/javascript' }));
page.on('console', m => console.log('console:', m.text()));
page.on('pageerror', e => console.log('pageerror:', e.message));
// Make a 4s webm with a tone in the browser.
await page.goto('file:///home/user/videdit/index.html');
const b64 = await page.evaluate(async () => {
  const c = document.createElement('canvas'); c.width = 320; c.height = 240;
  const g = c.getContext('2d');
  const ac = new AudioContext(); const osc = ac.createOscillator(); const dest = ac.createMediaStreamDestination();
  osc.connect(dest); osc.start();
  const stream = new MediaStream([...c.captureStream(30).getVideoTracks(), ...dest.stream.getAudioTracks()]);
  const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8,opus' });
  const chunks = []; rec.ondataavailable = e => chunks.push(e.data);
  let f = 0; const iv = setInterval(() => { g.fillStyle = `hsl(${f++*5},80%,50%)`; g.fillRect(0,0,320,240); }, 33);
  rec.start(); await new Promise(r => setTimeout(r, 4000)); rec.stop();
  await new Promise(r => rec.onstop = r); clearInterval(iv);
  const buf = await new Blob(chunks).arrayBuffer();
  let s = ''; new Uint8Array(buf).forEach(b => s += String.fromCharCode(b)); return btoa(s);
});
fs.writeFileSync('test.webm', Buffer.from(b64, 'base64'));
await page.setInputFiles('#fileInput', 'test.webm');
await page.waitForSelector('#editor:not([hidden])', { timeout: 10000 });
console.log('label:', await page.textContent('#fileName'));
// Cut: remove 1s-2s
await page.evaluate(() => { document.getElementById('video').currentTime = 1; });
await page.click('#splitBtn');
await page.evaluate(() => { document.getElementById('video').currentTime = 2; });
await page.click('#splitBtn');
await page.click('#segmentList tr:nth-child(2)');
await page.click('#toggleBtn');
console.log('summary:', await page.textContent('#summary'));
await page.waitForTimeout(300);
await page.screenshot({ path: 'shot.png', fullPage: true });
for (const fmt of ['wav', 'mp3']) {
  await page.selectOption('#format', fmt);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#exportBtn')]);
  const p = `out.${fmt}`; await dl.saveAs(p);
  console.log(fmt, dl.suggestedFilename(), fs.statSync(p).size, await page.textContent('#exportStatus'));
}
await browser.close();
