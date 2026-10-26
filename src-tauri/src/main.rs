#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use rusqlite::{params, Connection};
use std::{
    collections::HashSet,
    fs,
    io::{Read, Seek, SeekFrom, Write},
    path::PathBuf,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{
    http::{header, Response},
    ipc::{InvokeBody, Request},
    AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_opener::OpenerExt;

struct Store {
    conn: Mutex<Connection>,
    dir: PathBuf,
    media: PathBuf,
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn valid_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.bytes().all(|b| b.is_ascii_alphanumeric())
}

fn valid_day(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10 && b.iter().enumerate().all(|(i, c)| if i == 4 || i == 7 { *c == b'-' } else { c.is_ascii_digit() })
}

fn ext_for(mime: &str) -> &'static str {
    let m = mime.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    match m.as_str() {
        "image/jpeg" => "jpg", "image/png" => "png", "image/webp" => "webp", "image/gif" => "gif", "image/avif" => "avif",
        "video/mp4" => "mp4", "video/webm" => "webm", "video/quicktime" => "mov", "video/ogg" => "ogv",
        "video/x-matroska" => "mkv", "video/x-m4v" => "m4v",
        "audio/webm" => "weba", "audio/ogg" => "oga", "audio/mp4" => "m4a", "audio/mpeg" => "mp3",
        "audio/wav" | "audio/x-wav" => "wav", "audio/aac" => "aac",
        _ => "bin",
    }
}

fn migrate(c: &Connection) -> rusqlite::Result<()> {
    let v: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if v < 1 {
        c.execute_batch(
            "BEGIN;
             CREATE TABLE IF NOT EXISTS entries (day TEXT PRIMARY KEY, text TEXT NOT NULL DEFAULT '', mood TEXT NOT NULL DEFAULT '', photos TEXT, updated INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, ext TEXT NOT NULL, mime TEXT NOT NULL, bytes INTEGER NOT NULL, created INTEGER NOT NULL);
             PRAGMA user_version = 1;
             COMMIT;",
        )?;
    }
    if v < 2 {
        // voice notes kept with each page
        c.execute_batch("BEGIN; ALTER TABLE entries ADD COLUMN voice TEXT; PRAGMA user_version = 2; COMMIT;")?;
    }
    Ok(())
}

fn load_all(c: &Connection) -> serde_json::Value {
    let mut out = serde_json::Map::new();
    if let Ok(mut st) = c.prepare("SELECT day, text, mood, photos, voice FROM entries") {
        if let Ok(rows) = st.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, Option<String>>(3)?, r.get::<_, Option<String>>(4)?))
        }) {
            for (day, t, mood, photos, voice) in rows.flatten() {
                let mut e = serde_json::Map::new();
                e.insert("t".into(), t.into());
                e.insert("mood".into(), mood.into());
                if let Some(p) = photos {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&p) {
                        e.insert("b".into(), v);
                    }
                }
                if let Some(p) = voice {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&p) {
                        e.insert("v".into(), v);
                    }
                }
                out.insert(day, e.into());
            }
        }
    }
    out.into()
}

#[tauri::command]
fn db_save(state: State<Store>, out: String) -> Result<(), String> {
    let v: serde_json::Value = serde_json::from_str(&out).map_err(|e| e.to_string())?;
    let obj = v.as_object().ok_or("bad payload")?;
    let mut c = state.conn.lock().map_err(|_| "lock")?;
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let now = now_ms();
    let mut keep: HashSet<String> = HashSet::new();
    for (day, e) in obj {
        if !valid_day(day) { continue; }
        keep.insert(day.clone());
        let t = e.get("t").and_then(|x| x.as_str()).unwrap_or("");
        let mood = e.get("mood").and_then(|x| x.as_str()).unwrap_or("");
        let photos = match e.get("b").and_then(|b| b.as_object()) {
            Some(m) if !m.is_empty() => Some(e["b"].to_string()),
            _ => None,
        };
        let voice = match e.get("v").and_then(|b| b.as_object()) {
            Some(m) if !m.is_empty() => Some(e["v"].to_string()),
            _ => None,
        };
        tx.execute(
            "INSERT INTO entries (day, text, mood, photos, voice, updated) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(day) DO UPDATE SET text = excluded.text, mood = excluded.mood, photos = excluded.photos, voice = excluded.voice, updated = excluded.updated
             WHERE entries.text IS NOT excluded.text OR entries.mood IS NOT excluded.mood OR entries.photos IS NOT excluded.photos OR entries.voice IS NOT excluded.voice",
            params![day, t, mood, photos, voice, now],
        ).map_err(|e| e.to_string())?;
    }
    let days: Vec<String> = {
        let mut st = tx.prepare("SELECT day FROM entries").map_err(|e| e.to_string())?;
        let rows = st.query_map([], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
        rows.flatten().collect()
    };
    for d in days {
        if !keep.contains(&d) {
            tx.execute("DELETE FROM entries WHERE day = ?1", params![d]).map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())
}

#[tauri::command]
fn media_put_chunk(state: State<Store>, request: Request) -> Result<(), String> {
    let h = |k: &str| request.headers().get(k).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let id = h("x-id");
    if !valid_id(&id) { return Err("bad id".into()); }
    let mime = h("x-mime");
    let offset: u64 = h("x-offset").parse().map_err(|_| "bad offset")?;
    let last = h("x-last") == "1";
    let body = match request.body() {
        InvokeBody::Raw(b) => b,
        _ => return Err("expected raw body".into()),
    };
    let part = state.media.join(format!("{id}.part"));
    let mut f = if offset == 0 {
        fs::File::create(&part).map_err(|e| e.to_string())?
    } else {
        fs::OpenOptions::new().write(true).open(&part).map_err(|e| e.to_string())?
    };
    f.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    f.write_all(body).map_err(|e| e.to_string())?;
    drop(f);
    if last {
        let ext = ext_for(&mime);
        let dest = state.media.join(format!("{id}.{ext}"));
        fs::rename(&part, &dest).map_err(|e| e.to_string())?;
        let size = fs::metadata(&dest).map(|m| m.len() as i64).unwrap_or(0);
        let c = state.conn.lock().map_err(|_| "lock")?;
        c.execute(
            "INSERT OR REPLACE INTO media (id, ext, mime, bytes, created) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, ext, mime, size, now_ms()],
        ).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn media_del(state: State<Store>, id: String) {
    if !valid_id(&id) { return; }
    if let Ok(c) = state.conn.lock() {
        if let Ok(ext) = c.query_row("SELECT ext FROM media WHERE id = ?1", params![id], |r| r.get::<_, String>(0)) {
            let _ = fs::remove_file(state.media.join(format!("{id}.{ext}")));
        }
        let _ = c.execute("DELETE FROM media WHERE id = ?1", params![id]);
    }
}

fn gc(store: &Store) {
    let c = match store.conn.lock() { Ok(c) => c, Err(_) => return };
    let mut used: HashSet<String> = HashSet::new();
    if let Ok(mut st) = c.prepare("SELECT photos FROM entries WHERE photos IS NOT NULL UNION ALL SELECT voice FROM entries WHERE voice IS NOT NULL") {
        if let Ok(rows) = st.query_map([], |r| r.get::<_, String>(0)) {
            for p in rows.flatten() {
                let Ok(v) = serde_json::from_str::<serde_json::Value>(&p) else { continue };
                let Some(pages) = v.as_object() else { continue };
                for bundles in pages.values() {
                    for b in bundles.as_array().into_iter().flatten() {
                        if let Some(s) = b.get("id").and_then(|x| x.as_str()) { used.insert(s.into()); }
                        for it in b.get("p").and_then(|x| x.as_array()).into_iter().flatten() {
                            for k in ["id", "t"] {
                                if let Some(s) = it.get(k).and_then(|x| x.as_str()) { used.insert(s.into()); }
                            }
                        }
                    }
                }
            }
        }
    }
    let cutoff = now_ms() - 10 * 60 * 1000;
    let rows: Vec<(String, String, i64)> = match c.prepare("SELECT id, ext, created FROM media") {
        Ok(mut st) => st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).map(|it| it.flatten().collect()).unwrap_or_default(),
        Err(_) => return,
    };
    for (id, ext, created) in rows {
        if !used.contains(&id) && created < cutoff {
            let _ = fs::remove_file(store.media.join(format!("{id}.{ext}")));
            let _ = c.execute("DELETE FROM media WHERE id = ?1", params![id]);
        }
    }
}

#[tauri::command]
fn backup_data(app: AppHandle, state: State<Store>) -> Result<String, String> {
    let base = app.path().document_dir().or_else(|_| app.path().home_dir()).map_err(|e| e.to_string())?;
    let stamp = now_ms() / 1000;
    let dest = base.join(format!("Daybook backup {stamp}"));
    fs::create_dir_all(dest.join("media")).map_err(|e| e.to_string())?;
    {
        let c = state.conn.lock().map_err(|_| "lock")?;
        let p = dest.join("daybook.db").to_string_lossy().replace('\'', "''");
        c.execute_batch(&format!("VACUUM INTO '{p}'")).map_err(|e| e.to_string())?;
    }
    if let Ok(rd) = fs::read_dir(&state.media) {
        for e in rd.flatten() {
            if e.path().extension().map(|x| x != "part").unwrap_or(true) {
                let _ = fs::copy(e.path(), dest.join("media").join(e.file_name()));
            }
        }
    }
    Ok(dest.to_string_lossy().into_owned())
}

#[tauri::command]
fn open_data_dir(app: AppHandle, state: State<Store>) -> Result<(), String> {
    app.opener().open_path(state.dir.to_string_lossy().to_string(), None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn exit_app(app: AppHandle) {
    app.exit(0);
}

#[cfg(feature = "e2e")]
#[tauri::command]
fn e2e_report(app: AppHandle, data: String) {
    if let Ok(p) = std::env::var("DAYBOOK_E2E_OUT") { let _ = fs::write(p, data); }
    app.exit(0);
}

fn media_response(app: &AppHandle, req: tauri::http::Request<Vec<u8>>) -> Response<Vec<u8>> {
    let fail = |code: u16| Response::builder().status(code).body(Vec::new()).unwrap();
    let id = req.uri().path().trim_matches('/').to_string();
    if !valid_id(&id) { return fail(400); }
    let store = app.state::<Store>();
    let row = {
        let Ok(c) = store.conn.lock() else { return fail(500) };
        c.query_row("SELECT ext, mime FROM media WHERE id = ?1", params![id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).ok()
    };
    let Some((ext, mime)) = row else { return fail(404) };
    let Ok(mut f) = fs::File::open(store.media.join(format!("{id}.{ext}"))) else { return fail(404) };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    if len == 0 { return fail(404); }
    let mime = if mime.is_empty() { "application/octet-stream".to_string() } else { mime };
    let range = req.headers().get(header::RANGE).and_then(|v| v.to_str().ok()).and_then(|s| s.strip_prefix("bytes=")).map(|s| s.to_string());
    let (start, end, partial) = match range {
        Some(r) => {
            let mut it = r.splitn(2, '-');
            let a = it.next().unwrap_or("");
            let b = it.next().unwrap_or("");
            let (s, e) = if a.is_empty() {
                let n: u64 = b.parse().unwrap_or(0);
                (len.saturating_sub(n), len - 1)
            } else {
                let s: u64 = a.parse().unwrap_or(0);
                let e: u64 = if b.is_empty() { len - 1 } else { b.parse().unwrap_or(len - 1) };
                (s, e.min(len - 1))
            };
            if s >= len || s > e {
                return Response::builder().status(416).header(header::CONTENT_RANGE, format!("bytes */{len}")).body(Vec::new()).unwrap();
            }
            // keep each answer bounded so a long video never sits whole in memory
            (s, e.min(s + 8 * 1024 * 1024 - 1), true)
        }
        None => (0, len - 1, false),
    };
    let mut buf = vec![0u8; (end - start + 1) as usize];
    if f.seek(SeekFrom::Start(start)).is_err() || f.read_exact(&mut buf).is_err() { return fail(500); }
    let mut b = Response::builder()
        .header(header::CONTENT_TYPE, mime)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, buf.len().to_string())
        .header("Access-Control-Allow-Origin", "*")
        .header(header::CACHE_CONTROL, "no-store");
    if partial {
        b = b.status(206).header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"));
    } else {
        b = b.status(200);
    }
    b.body(buf).unwrap()
}

fn main() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_single_instance::init(|app, _a, _c| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .register_uri_scheme_protocol("daybook-media", |ctx, req| media_response(ctx.app_handle(), req))
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            let media = dir.join("media");
            fs::create_dir_all(&media)?;
            let conn = Connection::open(dir.join("daybook.db"))?;
            conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;")?;
            migrate(&conn)?;
            let boot = load_all(&conn).to_string();
            app.manage(Store { conn: Mutex::new(conn), dir, media });
            gc(&app.state::<Store>());

            let mut init = format!("window.__DAYBOOK_BOOT = {boot};\n{}", include_str!("shim.js"));
            #[cfg(feature = "e2e")]
            if let Ok(p) = std::env::var("DAYBOOK_E2E") {
                if let Ok(s) = fs::read_to_string(p) { init.push_str("\n"); init.push_str(&s); }
            }
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Daybook")
                .inner_size(1360.0, 900.0)
                .min_inner_size(360.0, 560.0)
                .center()
                .disable_drag_drop_handler()
                .initialization_script(init)
                .build()?;
            Ok(())
        })
        .on_window_event(|w, ev| {
            if let WindowEvent::CloseRequested { api, .. } = ev {
                api.prevent_close();
                if let Some(wv) = w.app_handle().get_webview_window(w.label()) {
                    let _ = wv.eval("window.__daybookQuit ? window.__daybookQuit() : window.__TAURI_INTERNALS__.invoke('exit_app')");
                }
                let app = w.app_handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(3));
                    app.exit(0);
                });
            }
        });
    #[cfg(feature = "e2e")]
    { builder = builder.invoke_handler(tauri::generate_handler![db_save, media_put_chunk, media_del, backup_data, open_data_dir, exit_app, e2e_report]); }
    #[cfg(not(feature = "e2e"))]
    { builder = builder.invoke_handler(tauri::generate_handler![db_save, media_put_chunk, media_del, backup_data, open_data_dir, exit_app]); }
    builder.run(tauri::generate_context!()).expect("error while running Daybook");
}
