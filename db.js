'use strict';
/* SQLite store for Daybook: entries live in a table, photos and videos live as files in a media folder
   with a row each, so a large video never has to pass through the database. Uses Node's built-in node:sqlite. */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/ogg': 'ogv', 'video/x-matroska': 'mkv', 'video/x-m4v': 'm4v',
};
const ID = /^[A-Za-z0-9]{1,64}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

class Store {
  constructor(dir) {
    this.dir = dir;
    this.mediaDir = path.join(dir, 'media');
    fs.mkdirSync(this.mediaDir, { recursive: true });
    this.dbPath = path.join(dir, 'daybook.db');
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
    this.migrate();
    this.q = {
      all: this.db.prepare('SELECT day, text, mood, photos FROM entries'),
      upsert: this.db.prepare(
        'INSERT INTO entries (day, text, mood, photos, updated) VALUES (?, ?, ?, ?, ?) ' +
        'ON CONFLICT(day) DO UPDATE SET text = excluded.text, mood = excluded.mood, photos = excluded.photos, updated = excluded.updated ' +
        'WHERE entries.text IS NOT excluded.text OR entries.mood IS NOT excluded.mood OR entries.photos IS NOT excluded.photos'),
      days: this.db.prepare('SELECT day FROM entries'),
      del: this.db.prepare('DELETE FROM entries WHERE day = ?'),
      mediaIns: this.db.prepare('INSERT OR REPLACE INTO media (id, ext, mime, bytes, created) VALUES (?, ?, ?, ?, ?)'),
      mediaGet: this.db.prepare('SELECT id, ext, mime FROM media WHERE id = ?'),
      mediaDel: this.db.prepare('DELETE FROM media WHERE id = ?'),
      mediaAll: this.db.prepare('SELECT id, ext, created FROM media'),
    };
  }

  migrate() {
    const v = this.db.prepare('PRAGMA user_version').get().user_version;
    if (v < 1) {
      this.db.exec(`
        BEGIN;
        CREATE TABLE IF NOT EXISTS entries (
          day     TEXT PRIMARY KEY,   -- YYYY-MM-DD
          text    TEXT NOT NULL DEFAULT '',
          mood    TEXT NOT NULL DEFAULT '',
          photos  TEXT,               -- JSON: clipped bundles per page
          updated INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS media (
          id      TEXT PRIMARY KEY,
          ext     TEXT NOT NULL,
          mime    TEXT NOT NULL,
          bytes   INTEGER NOT NULL,
          created INTEGER NOT NULL
        );
        PRAGMA user_version = 1;
        COMMIT;`);
    }
  }

  loadAll() {
    const out = {};
    for (const r of this.q.all.all()) {
      const e = { t: r.text || '', mood: r.mood || '' };
      if (r.photos) { try { e.b = JSON.parse(r.photos); } catch { /* ignore a damaged row */ } }
      out[r.day] = e;
    }
    return out;
  }

  /* make the table match `out` exactly: { 'YYYY-MM-DD': { t, mood, b? } } */
  saveAll(out) {
    if (!out || typeof out !== 'object') return;
    const now = Date.now();
    this.db.exec('BEGIN');
    try {
      const keep = new Set();
      for (const day of Object.keys(out)) {
        if (!DAY.test(day)) continue;
        const e = out[day] || {};
        keep.add(day);
        const photos = e.b && Object.keys(e.b).length ? JSON.stringify(e.b) : null;
        this.q.upsert.run(day, String(e.t || ''), String(e.mood || ''), photos, now);
      }
      for (const r of this.q.days.all()) if (!keep.has(r.day)) this.q.del.run(r.day);
      this.db.exec('COMMIT');
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw err;
    }
  }

  extFor(mime, name) {
    const fromName = name ? path.extname(name).slice(1).toLowerCase().replace(/[^a-z0-9]/g, '') : '';
    return EXT[String(mime).toLowerCase()] || fromName || 'bin';
  }

  putBuf(id, mime, buf) {
    if (!ID.test(id)) return false;
    const ext = this.extFor(mime);
    fs.writeFileSync(path.join(this.mediaDir, id + '.' + ext), buf);
    this.q.mediaIns.run(id, ext, mime || '', buf.length, Date.now());
    return true;
  }

  putPath(id, mime, file) {
    if (!ID.test(id) || typeof file !== 'string' || !fs.statSync(file).isFile()) return false;
    const ext = this.extFor(mime, file);
    const dest = path.join(this.mediaDir, id + '.' + ext);
    fs.copyFileSync(file, dest);
    this.q.mediaIns.run(id, ext, mime || '', fs.statSync(dest).size, Date.now());
    return true;
  }

  mediaFile(id) {
    if (!ID.test(id)) return null;
    const r = this.q.mediaGet.get(id);
    if (!r) return null;
    const f = path.join(this.mediaDir, r.id + '.' + r.ext);
    return fs.existsSync(f) ? { file: f, mime: r.mime } : null;
  }

  delMedia(id) {
    if (!ID.test(id)) return;
    const r = this.q.mediaGet.get(id);
    if (!r) return;
    try { fs.unlinkSync(path.join(this.mediaDir, r.id + '.' + r.ext)); } catch { /* already gone */ }
    this.q.mediaDel.run(id);
  }

  /* remove media no entry points at, once it is older than ten minutes (so a file being attached is never swept) */
  gc() {
    const used = new Set();
    for (const r of this.q.all.all()) {
      if (!r.photos) continue;
      let b; try { b = JSON.parse(r.photos); } catch { continue; }
      for (const page of Object.values(b)) for (const bundle of page) for (const p of bundle.p || []) { used.add(p.id); if (p.t) used.add(p.t); }
    }
    const cutoff = Date.now() - 10 * 60 * 1000;
    let n = 0;
    for (const m of this.q.mediaAll.all()) {
      if (!used.has(m.id) && m.created < cutoff) { this.delMedia(m.id); n++; }
    }
    return n;
  }

  /* a consistent copy of everything: database plus media folder */
  backup(dest) {
    fs.mkdirSync(dest, { recursive: true });
    const dbCopy = path.join(dest, 'daybook.db');
    if (fs.existsSync(dbCopy)) fs.unlinkSync(dbCopy);
    this.db.exec(`VACUUM INTO '${dbCopy.replace(/'/g, "''")}'`);
    fs.cpSync(this.mediaDir, path.join(dest, 'media'), { recursive: true });
    return dest;
  }

  close() { try { this.db.close(); } catch { /* ignore */ } }
}

module.exports = { Store };
