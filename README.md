# VidEdit

A simple in-browser video editor: import a video, cut out the parts you don't want, and export the result as **audio** (MP3 or WAV).

Everything runs locally in your browser — your video is never uploaded anywhere.

## How to use

1. Open `index.html` in a modern browser (Chrome, Edge, Firefox, Safari).
2. Click **Import video** (or drag a video file onto the page).
3. Cut it:
   - Click the waveform timeline to move the playhead.
   - **Split at playhead** (`S`) cuts the video into segments.
   - Click a segment, then **Remove segment** (`Delete`) to drop it. Click again to restore.
   - **Trim start / end to playhead** (`[` / `]`) removes everything before / after the playhead.
   - **Undo** (`Ctrl+Z`) and **Reset cuts** are available.
   - Press **Play** (`Space`) to preview — removed parts are skipped.
4. Choose **MP3** or **WAV** and click **Export**. The kept segments are joined and downloaded as one audio file.

Other shortcuts: `←` / `→` step 0.1 s (hold `Shift` for 1 s), `+` / `-` zoom the timeline, `0` fits the whole file. Scrolling the mouse wheel over the timeline zooms too.

## Large files

VidEdit is built to handle very large videos (tested with multi‑GB files and 8+ hour recordings):

- The file is never loaded into memory. The preview streams from disk, and audio is processed by [ffmpeg](https://ffmpeg.org/) (WebAssembly) in a background worker that reads only the parts it needs.
- You can start cutting as soon as the video opens; the waveform fills in in the background.
- Export jumps straight to the parts you kept, so cutting a few minutes out of a huge file takes seconds.
- Exports download like any other file. Very large exports (over 1 GB) in Chrome/Edge ask where to save and are written straight to disk as they're encoded.
- WAV files are limited to 4 GB (about 6.7 hours of audio); use MP3 for longer exports.

## Notes

- The audio engine (~30 MB) is downloaded from a CDN the first time and cached by the browser afterwards, so an internet connection is needed on first use.
- ffmpeg can read almost any format (MP4, MOV, MKV, WebM, AVI, HEVC, audio files…). If your browser can't show a video's picture itself, VidEdit shows the frame at the playhead instead, updating as you move or play.
