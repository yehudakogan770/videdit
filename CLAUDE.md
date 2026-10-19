# VidEdit — notes for Claude

**Read HANDOFF.md first for the full history, current status, and where everything lives.**

## What this is

VidEdit is a video editor that runs entirely in the browser. The user imports one or more
videos (often huge, up to ~4 GB), cuts out the parts they don't want, and **exports the audio
only** (MP3 or WAV). There is no server, no build step for the app itself and no account: the
user downloads a single file, `VidEdit.html`, and double-clicks it to open it in Chrome or Edge.

## How the user likes things done

- **Plain language.** The user is not a programmer. Keep replies short and concrete; explain
  what changed and what they need to do (usually "replace your copy of VidEdit.html").
- **They use the single-file build.** After every change to the app, rebuild
  `dist/VidEdit.html` (`npm run build`) and send them the new file. They open it from their own
  computer; they do not run a server.
- **Big imports, small exports.** Imported videos are large (they said "probably under 4 GB");
  exports are short audio clips. Never load a whole file into memory.
- **They must be able to see the video** while cutting, whatever the format.
- **Several videos, edited one at a time** ("i only edit one at a time"). No joining videos together.
- **When a video is finished it goes away:** the user asked for both "remove from the list" and
  "delete the original file from the computer". Deleting is a button the user clicks after a
  successful export (with Chrome's permission prompt plus a confirmation), never automatic.
- **Test before handing over.** Every fix so far was reproduced, then verified in a real browser
  (Playwright + Chromium). Keep doing that; say plainly what was and wasn't tested.
- **Git:** work on branch `claude/lucid-hawking-7qxxlw` of `yehudakogan770/videdit` (or the
  branch the session assigns), commit after each finished piece with a clear message, push.
  Don't open pull requests or merge to `main` unless the user asks.

## Structure

| File | What it is |
|---|---|
| `index.html` | Page markup |
| `style.css` | Styles (dark theme, CSS variables in `:root`) |
| `app.js` | All logic, plain JavaScript, no framework, no bundler |
| `tools/build_single_file.py` | Inlines CSS + JS into `dist/VidEdit.html` (the file users get) |
| `tests/e2e.mjs` | End-to-end test in real Chromium via `playwright-core` |
| `tests/gen_wav.py` | Makes test WAVs where each second has a known sample value |
| `tests/fixtures/` | Small test videos (`test.webm` plays in Chromium; `h264_opus.mp4` doesn't show its picture there) |
| `handoff-files/` | Everything produced in the original chat outside the repo (see HANDOFF.md) |

Key design points in `app.js`:
- Audio work is done by **ffmpeg.wasm** (`@ffmpeg/core@0.12.10`, loaded from cdn.jsdelivr.net)
  inside Web Workers created from a `blob:` URL (`workerMain` is serialized with `toString()`),
  so the page works from `file://`.
- Input files are mounted with Emscripten **WORKERFS** (reads only the slices ffmpeg needs);
  output streams out through a custom **device file `/out`** (`FS.registerDevice`). This is what
  makes multi-GB files work.
- Export = one ffmpeg run with one `-ss/-t` input per kept segment + a `concat` filter
  (sample-exact, fast because it seeks).
- Per-video state lives on clip objects; `state.segments`, `state.duration` etc. are forwarded
  to the active clip via `Object.defineProperty` (see `CLIP_KEYS`).
- When the browser can't decode the picture (`video.videoWidth === 0` or the file won't load),
  ffmpeg renders the frame at the playhead as **PNG** (its MJPEG encoder crashes in this build).
  ffmpeg.wasm leaks memory per run, so the frame engine is **swapped for a pre-warmed one every
  40 frames** (`FRAMES_PER_ENGINE`).
- Small exports download normally; exports over 1 GB use `showSaveFilePicker` and stream to disk.

## Commands

```bash
npm install                      # once; installs playwright-core (test only)
npm run build                    # -> dist/VidEdit.html
npm test                         # e2e test against index.html (needs internet for the CDN)
PAGE=dist node tests/e2e.mjs     # same test against the built single file
LONG=1 node tests/e2e.mjs        # adds the 600-frame preview stress test (~2.5 min)
node --check app.js              # quick syntax check
```

In Claude Code cloud sessions Chromium is at `/opt/pw-browsers/chromium` (the default in the
test); elsewhere set `CHROMIUM_PATH`. Don't run `playwright install`.

There is no deployment: nothing is hosted. "Releasing" means sending the user the rebuilt
`dist/VidEdit.html`.

## Always / never

- Always keep it working from `file://` with no server (inline worker via blob URL, no ES modules
  loaded from disk, no `fetch` of local files).
- Always keep memory flat for huge files: stream, never `file.arrayBuffer()` on the input.
- Always rebuild and re-run `npm test` (and `PAGE=dist`) before sending a new build.
- Never delete a user's original file without an explicit click, Chrome's permission and a confirm.
- Never commit secrets (there are none in this project) or files over 100 MB.
- Never change the CDN version of `@ffmpeg/core` without re-testing export, waveform and frames
  (the device-file trick depends on Emscripten FS internals).
- Don't try to publish it as a claude.ai Artifact: the artifact sandbox can't save `.mp3`/`.wav`
  files and blocks fetching the ffmpeg `.wasm` from the CDN.
