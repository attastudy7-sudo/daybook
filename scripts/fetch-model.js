'use strict';
/* Downloads the speech model that Daybook bundles for voice-note transcription (whisper.cpp format).
   Usage: node scripts/fetch-model.js [model]   e.g. base.en-q5_1 (default, ~60 MB) or tiny.en-q5_1 (~32 MB)
   A failed download only warns, so a build still works (without transcription) unless DAYBOOK_REQUIRE_MODEL=1. */
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const name = process.argv[2] || process.env.DAYBOOK_MODEL_NAME || 'base.en-q5_1';
const dir = path.join(__dirname, '..', 'src-tauri', 'resources');
const file = path.join(dir, `ggml-${name}.bin`);
const url = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${name}.bin`;

(async () => {
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(file) && fs.statSync(file).size > 10e6) { console.log('speech model present:', path.basename(file)); return; }
  // only one model is bundled: remove any other so the installer stays small
  for (const f of fs.readdirSync(dir)) if (/^ggml-.*\.bin(\.part)?$/.test(f)) fs.rmSync(path.join(dir, f));
  console.log('downloading speech model', name, '...');
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(file + '.part'));
  fs.renameSync(file + '.part', file);
  console.log('saved', path.basename(file), Math.round(fs.statSync(file).size / 1048576) + ' MB');
})().catch((e) => {
  try { fs.rmSync(file + '.part', { force: true }); } catch {}
  const msg = 'Could not download the speech model (' + (e && e.message || e) + '). Voice notes will not be transcribed in this build.';
  if (process.env.DAYBOOK_REQUIRE_MODEL === '1') { console.error(msg); process.exit(1); }
  console.warn('WARNING: ' + msg);
});
