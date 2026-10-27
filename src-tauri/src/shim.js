(function () {
  var inv = function (cmd, args, opts) { return window.__TAURI_INTERNALS__.invoke(cmd, args, opts); };
  var last = Promise.resolve();
  var CH = 8 * 1024 * 1024;
  window.daybookNative = {
    platform: 'tauri',
    loadAll: function () { return window.__DAYBOOK_BOOT || {}; },
    save: function (out) { last = inv('db_save', { out: JSON.stringify(out) }).catch(function () {}); return last; },
    saveSync: function (out) { last = inv('db_save', { out: JSON.stringify(out) }).catch(function () {}); },
    putBlob: function (id, blob) {
      var mime = blob.type || '';
      var total = blob.size, off = 0;
      function next() {
        var end = Math.min(off + CH, total);
        return blob.slice(off, end).arrayBuffer().then(function (buf) {
          return inv('media_put_chunk', buf, { headers: { 'x-id': id, 'x-mime': mime, 'x-offset': String(off), 'x-last': end >= total ? '1' : '0' } });
        }).then(function () { off = end; return off >= total ? true : next(); });
      }
      if (total === 0) return Promise.resolve(false);
      return next().catch(function () { return false; });
    },
    delMedia: function (id) { inv('media_del', { id: id }).catch(function () {}); },
    mediaUrl: function (id) { return window.__TAURI_INTERNALS__.convertFileSrc(id, 'daybook-media'); },
    canTranscribe: function () { return inv('stt_ready'); },
    transcribe: function (pcm) { return inv('transcribe', pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength)); },
    backup: function () { return inv('backup_data'); },
    openFolder: function () { return inv('open_data_dir'); }
  };
  window.__daybookQuit = function () {
    var f = Promise.resolve();
    try { if (window.__daybookFlush) window.__daybookFlush(); } catch (e) {}
    return Promise.resolve(last).catch(function () {}).then(function () { return inv('exit_app'); });
  };
})();
