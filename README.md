# Daybook

A bound journal with a page for every day, kept on your own computer. Photos, videos and voice notes can be clipped to any page.

Built with [Tauri](https://tauri.app): a Rust shell around the system webview. The app itself is ~6 MB; the bundled speech model adds ~60 MB (Electron alone was ~80 MB before any model).

## Where your data lives

Everything is stored locally; nothing is uploaded.

| OS | Folder |
|---|---|
| Windows | `%APPDATA%\com.daybook.app` |
| macOS | `~/Library/Application Support/com.daybook.app` |
| Linux | `~/.local/share/com.daybook.app` |

`daybook.db` is a SQLite file (entries and the list of attachments). `media/` holds photos, videos and voice notes. **Settings → Back up** copies both into your Documents folder.

## Voice notes and transcription

Each page has a small mic button (bottom of the page). A recording is saved as a 16 kHz WAV, and the words are typed into the page's text where the note was recorded. Transcription runs **on your computer** with [whisper.cpp](https://github.com/ggml-org/whisper.cpp) and a bundled model; no audio leaves the machine. Turn it off in Settings → Voice notes.

The model (`ggml-base.en-q5_1.bin`, ~60 MB, English) is downloaded by `scripts/fetch-model.js` at build time and shipped inside the installer. To trade accuracy for size, build with `node scripts/fetch-model.js tiny.en-q5_1` (~32 MB). For other languages use a multilingual model (e.g. `base-q5_1`).

## Run it

You need [Node 20+](https://nodejs.org) and [Rust](https://rustup.rs). On Linux also: `libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev librsvg2-dev patchelf`.

```
npm install
npm run dev      # also downloads the speech model the first time
```

You also need `cmake` and a C++ compiler (whisper.cpp is compiled into the app) and `libclang` (LLVM).

## Build an installer

```
npm run build
```

The installer appears in `src-tauri/target/release/bundle/`. A build only produces installers for the OS it runs on.

## Release for all systems (GitHub)

Push a version tag and `.github/workflows/release.yml` builds Windows, macOS and Linux installers and attaches them to a GitHub release:

```
git tag v1.0.1
git push origin v1.0.1
```

Installers are unsigned, so Windows SmartScreen / macOS Gatekeeper warn on first launch ("More info → Run anyway", or right-click → Open on a Mac).

## Layout

- `src/daybook.html` – the whole app UI (single file; also runs in a plain browser using localStorage/IndexedDB)
- `src-tauri/src/main.rs` – SQLite store, media files (served with range support so video seeks), backup
- `src-tauri/src/shim.js` – the small bridge exposed to the page as `window.daybookNative`
- `scripts/build-web.js` – turns `src/daybook.html` plus `fonts/` into `dist/`

## Notes

- Video playback uses the system webview: fine on Windows (WebView2) and recent macOS; on Linux it depends on the installed GStreamer plugins. Voice recording does not depend on codecs.
- Voice notes: up to three per page, 10 minutes each.
