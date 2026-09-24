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

Other shortcuts: `←` / `→` step 0.1 s (hold `Shift` for 1 s).

## Notes

- MP3 encoding uses [lamejs](https://github.com/zhuker/lamejs), loaded from a CDN the first time you export MP3. WAV export works fully offline.
- Supported input formats are whatever your browser can decode (MP4/H.264+AAC, WebM, MOV in most browsers, plus audio files).
- Very long videos are decoded into memory, so multi-hour files may be slow.
