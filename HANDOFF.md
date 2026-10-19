# VidEdit — handoff

This file lets a new Claude session pick up exactly where the original chat (September 2026,
claude.ai Claude Code cloud session) left off. Read `CLAUDE.md` too: it has the user's
preferences and the rules for working on this repo.

## 1. What the project is

A video editor that runs in the browser. The user:

1. adds one or more videos (often very large, up to ~4 GB, any common format),
2. sees the video and a waveform timeline, and cuts out the parts they don't want,
3. exports **only the audio** of what's left, as MP3 or WAV,
4. when done with a video, deletes the original file and removes it from the list, then moves
   on to the next one.

It is delivered as **one file, `VidEdit.html`**, which the user saves and double-clicks to open in
Chrome or Edge. Nothing is installed and nothing is hosted.

## 2. Current status

**Finished and tested (all on branch `claude/lucid-hawking-7qxxlw`):**
- Import: **Add videos** button (Chrome/Edge file picker with file handles; plain file input
  elsewhere) and drag and drop, several files at once.
- Video list: each video keeps its own cuts, undo history, zoom and waveform; switching is instant.
- Preview: native `<video>` when the browser can show the picture; otherwise frames rendered
  by ffmpeg at the playhead (updates ~0.15 s after a move; a "slideshow" during playback).
- Timeline: waveform (built in the background), time ruler, zoom (wheel / + / − / Fit), scroll bar,
  click/drag to seek, follows the playhead.
- Editing: split at playhead (`S`), remove/restore segment (`Delete`), trim start/end
  (`[` / `]`), undo (`Ctrl+Z`), reset, segment table, play with removed parts skipped (`Space`),
  arrow keys step 0.1 s (`Shift` 1 s).
- Export: MP3 (128/192/320 kbps) or WAV, sample-exact cuts, 5 ms fades at joins, progress bar,
  cancel. Exports over 1 GB stream straight to disk through a save dialog (Chrome/Edge).
- Finishing: after export, **Delete original file & remove from list** (Chrome/Edge; permission
  prompt + confirm) or **Remove from list only**; the next video opens.
- Massive files: tested with 2.3 GB and 5.3 GB files (8 h 20 min); the editor opens instantly,
  memory stays flat, and cutting clips from anywhere (even past 4 GB) takes 1–2 s.
- Fixed: picture freezing after ~25 s while sound continued (ffmpeg.wasm crash; see decisions).
- Build script (`npm run build`) and an end-to-end test (`npm test`); 13/13 checks pass on both
  `index.html` and the built `dist/VidEdit.html`.

**Not finished / open items:**
- **UNCONFIRMED by the user:** the freeze fix. The user reported "video stops after certain
  amount of time but the audio continues"; we reproduced that in the frame-preview mode and fixed
  it, but the user never said which mode they saw. If it still happens with a normal play bar under
  the video, that's Chrome's own player (a different cause, not investigated).
- **UNCONFIRMED on a real disk:** "Delete original" was tested with the browser's private storage
  (OPFS) standing in for a real file. On Windows, a file still open elsewhere may refuse deletion
  (the app releases its own handles first and shows an error if deletion fails).
- **UNCONFIRMED:** the >1 GB save-to-disk path was tested with a stub writer, not the real Chrome
  save dialog.
- **Needs the user's decision:** a web link instead of a downloaded file. Possible with GitHub Pages
  (the repo is public; Pages is currently **off**). The user would have to turn it on in the
  repo settings, or ask Claude to set it up. Not done.
- Cosmetic: when opening a video whose length the browser can't read, the editor briefly shows the
  drop area until ffmpeg reports the length.
- Known limits (by design): WAV exports are capped at 4 GB (~6.7 h; use MP3); deleting originals
  works only in Chrome/Edge; the first use needs internet to download the ffmpeg engine (~30 MB,
  cached afterwards); the frame preview is not smooth video.

## 3. How it's built

| File | Purpose |
|---|---|
| `index.html` | Markup: header (Add videos), video list, drop zone, editor (video / frame preview, transport, zoom, timeline, tools, segment table, export box, finish box) |
| `style.css` | Dark theme, CSS variables in `:root` |
| `app.js` | All logic (plain JS, no framework) |
| `tools/build_single_file.py` | Inlines `style.css` and `app.js` into `dist/VidEdit.html` |
| `tests/e2e.mjs`, `tests/gen_wav.py`, `tests/fixtures/` | End-to-end test (see section 5) |
| `package.json` | `npm run build`, `npm test`; dev dependency `playwright-core` |
| `README.md` | User-facing instructions |

`app.js` sections, in order: utilities → **ffmpeg worker** (`workerMain`: init/mount, `probe`,
`peaks`, `exportAudio`, `frame`) → `runWorker` → **frame preview** (engine rotation) →
**importing** (picker, input, drag and drop, background duration read) → **video list**
(`renderClips`, `openClip`, `removeClip`, `releaseActive`) → `analyze` (waveform) →
**finishing** (delete/remove) → editing → playback → timeline view/drawing → segment list /
`update()` → export (`openOutput`, WAV header, export click).

How the heavy lifting works:
- **ffmpeg.wasm** `@ffmpeg/core@0.12.10` (UMD build from cdn.jsdelivr.net) runs in Web Workers made
  from a `blob:` URL, so the page works opened as a local `file://`.
- The input `File` is mounted with **WORKERFS**: ffmpeg reads slices on demand, never the whole file.
- Output goes to a custom **character device `/out`** whose `write()` forwards bytes to the page in
  1 MB chunks, so ffmpeg never holds the output in its own memory.
- **Waveform:** one ffmpeg pass decodes the first audio track at 8 kHz mono; the worker keeps the peak
  of each 1/20 s and streams them to the page.
- **Export:** one ffmpeg run with one `-ss start -t length -i input` per kept segment,
  `asetpts, apad, atrim` (exact length) plus fades, then `concat`, then `libmp3lame` or raw PCM
  (WAV header written by the page).
- **Frames:** `-ss t -i input -frames:v 1` scaled to ≤960×540, encoded as PNG.

## 4. Important decisions and why

1. **Browser app, no install/server:** the user wanted something usable immediately; a local HTML
   file works for them with no setup.
2. **Started with Web Audio + lamejs, replaced with ffmpeg.wasm:** the first version decoded the
   whole file in memory (`decodeAudioData`), which would crash on big files. The user said "it
   should be able to hold massive files", so everything moved to streaming ffmpeg.wasm.
3. **Seek-based export:** exports are short ("my exports are small, my imports are big"), so
   export reads only the kept ranges, which takes seconds even on huge files.
4. **Save dialog only above 1 GB:** small exports simply download; the dialog was an unnecessary
   step for the user's typical case.
5. **Single HTML file, not a claude.ai Artifact:** when asked to "launch it now", publishing as an
   Artifact was checked and rejected. Artifact downloads only allow certain extensions (no
   mp3/wav), and the sandbox blocks fetching the ffmpeg `.wasm` from the CDN. So the user got
   `VidEdit.html` to save and open. Nothing was published.
6. **Frame preview via ffmpeg:** the user said "i need to be able to see the vid". Formats Chrome
   can't show (HEVC .mov, some .mkv/.avi) now get frames rendered by ffmpeg. **PNG** because this
   ffmpeg build crashes in its MJPEG encoder (verified).
7. **Video list, one at a time:** the user asked to import multiple videos and answered "i only edit
   one at a time", so there's a list with per-video state and no joining.
8. **Delete originals = explicit button after export:** the user answered "both" (remove from list
   AND delete the original). Deletion is a click after a successful export, plus Chrome's
   permission and a confirm dialog, so a failed or partial export can never lose the original.
   It needs file handles, so import uses `showOpenFilePicker` and drag and drop handles.
9. **Engine rotation every 40 frames:** the freeze came from ffmpeg.wasm leaking memory per run
   and crashing after ~100 frames; after four crashes the preview gave up. A pre-warmed spare
   engine now takes over every 40 frames; it gives up only after three crashes in a row with
   no good frame.

## 5. How to run, test and "deploy"

```bash
npm install                      # playwright-core (tests only)
npm run build                    # -> dist/VidEdit.html  (dist/ is git-ignored)
npm test                         # 13 checks against index.html
PAGE=dist node tests/e2e.mjs     # same checks against the built file
LONG=1 node tests/e2e.mjs        # + 600-frame stress test of the frame preview
```

- To use it: open `index.html` (development) or `dist/VidEdit.html` (what the user gets) in Chrome.
- Tests need internet (jsdelivr CDN) and Chromium; in Claude Code cloud sessions that's
  `/opt/pw-browsers/chromium` (the default). Otherwise set `CHROMIUM_PATH`.
- For big-file testing: `python3 tests/gen_wav.py big.wav 13000` (2.3 GB) or
  `python3 tests/gen_wav.py huge.wav 30000 rf64` (5.3 GB). Don't commit them.
- **Deploy:** there is none. Rebuild, then send the user the new `dist/VidEdit.html`.
  A pre-built copy of the current version is in `handoff-files/app/VidEdit.html`.

## WHERE EVERYTHING LIVES

### GitHub
| What | Details |
|---|---|
| Repo | **`yehudakogan770/videdit`**, https://github.com/yehudakogan770/videdit, **public**, owner `yehudakogan770` |
| Branch with all the work | **`claude/lucid-hawking-7qxxlw`** |
| `main` | Default branch; contains only the initial commit (a 9-byte README). Nothing merged. |
| Pull requests | None |
| Other repos | None. This project uses no other repository. |

### Hosting, domains, databases
- **Hosting:** none. The app is a local HTML file on the user's computer. GitHub Pages is **off**
  (checked via the GitHub API), so merging to `main` would not publish anything.
- **Live URLs / admin pages:** none.
- **Domains:** none.
- **Databases / storage:** none. Everything happens in the user's browser; nothing is uploaded.
- **claude.ai Artifacts:** none published (considered and rejected, see decision 5).

### Outside services the app uses
| Service | Used for | Account needed |
|---|---|---|
| **cdn.jsdelivr.net** → `npm/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.js` and `ffmpeg-core.wasm` (~31 MB) | The ffmpeg engine, downloaded by the page at runtime (first use needs internet; then browser-cached) | No |
| npm registry → `playwright-core` | Running the tests only | No |
| (formerly) cdn.jsdelivr.net → `lamejs@1.2.1` | MP3 encoding in the first version; **no longer used** | No |

### Environment variables / keys
- **The app uses no API keys, passwords or environment variables.**
- Test-only, optional, not secret: `CHROMIUM_PATH` (path to Chromium), `PAGE` (`dist` to test the
  built file), `LONG` (`1` for the stress test).
- Cloud sessions set `HTTPS_PROXY` themselves (Claude Code environment); the project doesn't
  need it.

### Files outside the repo
- **The user's videos** live on the user's own computer. VidEdit never copies or uploads them; if
  the user uses "Delete original", that file is deleted from their computer.
- **The user's copy of `VidEdit.html`**: wherever the user saved it (location **UNCONFIRMED**,
  probably Desktop or Downloads). Four versions were sent during the chat; the newest is identical
  to `handoff-files/app/VidEdit.html`.
- **The original chat** is in the user's old claude.ai account (cloud session
  `session_01VU9jFF6kzkuZYw13PP3woT`) and will not transfer.
- **Large test files not saved** (over GitHub's 100 MB limit; regenerate with `tests/gen_wav.py`):
  `big.wav` (2,293,200,044 bytes) and `huge.rf64.wav` (5,292,000,080 bytes).

### Assumptions / unconfirmed
- UNCONFIRMED: the user mainly uses Chrome on Windows or Mac (we assumed Chrome/Edge; deleting
  originals needs them).
- UNCONFIRMED: the user's videos are typically under 4 GB (the user said "probably").
- UNCONFIRMED: which preview mode the user saw when reporting the freeze (see section 2).
- UNCONFIRMED: real-disk deletion and the real >1 GB save dialog (tested with stand-ins only).

## 6. Files in `handoff-files/`

Everything created in the original chat outside the repo (from the session's scratch folder).
Nothing was uploaded by the user during the chat.

| Path | What it is |
|---|---|
| `app/VidEdit.html` | Current single-file build, identical to the last copy sent to the user |
| `test-scripts/test.mjs` | First test: small WebM, cut, export WAV/MP3 (first version) |
| `test-scripts/test2.mjs` | Massive-file tests: 2.3 GB WAV and 5.3 GB RF64, sample-exact checks, memory |
| `test-scripts/test3.mjs` | Save-to-disk path with a stub writer: 1.27 GB WAV, 5 h MP3, disk-full handling |
| `test-scripts/test4.mjs` | 10-minute MP3 from a 2.3 GB file through the UI |
| `test-scripts/test5.mjs` | Tests the single-file build opened from disk |
| `test-scripts/test6.mjs` | Frame preview for H.264 videos (no native picture) |
| `test-scripts/test7.mjs`, `test7b.mjs` | Multi-video import, switching, remove from list, delete original (OPFS stand-in) |
| `test-scripts/stress.mjs` | Frame-preview stress test (reproduced and verified the freeze fix) |
| `test-scripts/mk.mjs` | Generates the H.264 test videos with ffmpeg.wasm |
| `test-scripts/dbg.mjs` … `dbg5.mjs` | Debugging the ffmpeg frame crash (found MJPEG crashes, PNG works) |
| `test-scripts/shot8.mjs` | Screenshot of the video list UI |
| `test-scripts/gen.py` | Original test-WAV generator (same as `tests/gen_wav.py`) |
| `test-scripts/package.json`, `package-lock.json` | Scratch folder's npm setup (playwright-core) |
| `test-media/test.webm` | 4 s VP8/Opus test video (made with MediaRecorder; also in `tests/fixtures/`) |
| `test-media/h264_opus.mp4` | 2 min H.264 + Opus: Chromium plays the sound only (also in `tests/fixtures/`) |
| `test-media/h264_aac.mp4` | 2 min H.264 + AAC: Chromium can't play it at all |
| `export-samples/out.wav`, `out.mp3` | Exports from the first version |
| `export-samples/o1.wav`, `o1.mp3` | Exports of the small WebM after the ffmpeg rewrite |
| `export-samples/o2.wav` | Cut from the 2.3 GB WAV (verified sample-exact) |
| `export-samples/o3.wav` | Cut from the 5.3 GB RF64, including data past 4 GB (verified) |
| `export-samples/o4.mp3` | 10-minute MP3 cut from the 2.3 GB file |
| `export-samples/o5.mp3` | 1-minute MP3 from the single-file build |
| `export-samples/o7.wav` | Export from the multi-video test |
| `screenshots/shot.png` | First version UI |
| `screenshots/shot-webm.png`, `shot-big.png`, `shot-huge.png` | Streaming version with small, 2.3 GB and 8 h files (zoomed timeline) |
| `screenshots/shot-h264_aac.mp4.png`, `shot-h264_opus.mp4.png` | Frame preview showing the right frame |
| `screenshots/shot8.png` | Video list + finish box |
| `third-party/ffmpeg-core-0.12.10.js` | Copy of the ffmpeg core loader inspected during development (the app loads it from the CDN; the 31 MB `.wasm` wasn't saved) |
| `third-party/lamejs-1.2.1.min.js` | MP3 encoder used by the first version (no longer used) |

Not saved (too big for GitHub): `big.wav` (2.29 GB) and `huge.rf64.wav` (5.29 GB), both generated
test audio; recreate with `tests/gen_wav.py`. Also not saved: the scratch folder's `node_modules`
(reinstall with `npm install`).

## 7. The conversation, start to finish

1. **"i want a video editor that i can import a video and cut it and export it as audio".** The
   repo was empty (README only). Built a browser app: decode audio with Web Audio, waveform
   timeline, split/remove/trim/undo, preview that skips cuts, WAV export and MP3 via lamejs from
   a CDN. Tested in headless Chromium. Pushed.
2. **"it should be able to hold masive files".** The first version loaded whole files into memory.
   Rewrote around ffmpeg.wasm in a worker with WORKERFS input and a device-file output: instant
   open, background waveform, seek-based export, save-to-disk streaming, zoomable timeline, cancel
   and progress. Tested with 2.3 GB and 5.3 GB files: sample-exact, memory flat. A WebM export
   came out 62 ms short, fixed with `apad,atrim`. Disk-write failures now stop the export cleanly.
3. **"my files that i import are probobly under 4GB"** and **"my exports are small, my imports are
   big"**. Confirmed the design fits. Small exports now download directly; the save dialog only
   appears above 1 GB.
4. **"luanch it now so i can start using it"**. Considered a claude.ai Artifact; rejected because
   of the download type allowlist (no mp3/wav) and CDN fetch blocking. Built a single
   self-contained `VidEdit.html`, tested it from `file://`, and sent it.
5. **"i need to be able to see the vid also"**. Added detection for videos whose picture the
   browser can't show, and a frame preview rendered by ffmpeg. Found ffmpeg's MJPEG encoder
   crashes and switched to PNG. Tested with H.264 files that Chromium can't decode. Sent the new file.
6. **"and i should be able to import multyple vids"** (began restructuring), then **"after i finnish
   with a vid it should delete the file"**. Asked the user: delete answer **"both"** (remove from
   list + delete the original); multiple-videos answer **"i only edit one at a time"**. Built the
   video list with per-video state, background length reading, and the finish box with the delete
   button (permission + confirm, Chrome/Edge). Tested with OPFS standing in for a real disk. Sent the new file.
7. **"video stops after certain amount of times but the audio continues"**. Reproduced: ffmpeg.wasm
   crashed about every 100 frames; after four crashes the preview stopped. Fixed with engine
   rotation every 40 frames with a pre-warmed spare. Verified 944 frames with no crash. Sent the new file.
8. **Handoff request** (moving to a new Claude account). Committed everything; added the build
   script, the end-to-end test suite and `package.json`; collected all chat files into
   `handoff-files/`; wrote `CLAUDE.md` and this file. Everything is on branch
   `claude/lucid-hawking-7qxxlw`; `main` is untouched.

## 8. Picking up from here

Likely next requests and where to start:
- "The picture still freezes": ask whether there's a normal play bar (native player) or just a
  picture (frame preview). For the frame preview, check `FRAMES_PER_ENGINE` and `frameEngineCrashed`.
- "Give me a link": set up GitHub Pages for the repo (needs the user's OK; nothing secret is
  involved; the app works over https too).
- "Delete didn't work": check the error shown under the finish box; on Windows another program may
  have the file open.
- Any change: edit `app.js`/`index.html`/`style.css`, run `npm test` and `PAGE=dist node tests/e2e.mjs`,
  `npm run build`, commit, push, and send the user `dist/VidEdit.html`.
