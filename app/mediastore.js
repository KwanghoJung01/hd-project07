/**
 * mediastore.js — 미디어 전용 IndexedDB 스토어 (음성/이미지/영상 Blob)
 *
 * localStorage 이슈 데이터와 분리: Issue 에는 media_id 참조만 저장하고
 * 원본 Blob 은 IndexedDB 에 불변 보존한다(DP-1, FR-27 원본 미디어 정책의 저장 계층).
 * Phase 2 에서 서버 오브젝트 스토리지로 교체되는 지점.
 */
(function (root) {
  "use strict";

  var DB_NAME = "field_insight_media_v1";
  var STORE = "media";
  var dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "media_id" });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbPromise;
  }

  function tx(mode, fn) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE, mode);
        var store = t.objectStore(STORE);
        var out = fn(store);
        t.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : undefined); };
        t.onerror = function () { reject(t.error); };
      });
    });
  }

  /** Blob 저장. record = {media_id, kind, name, mime, size, duration_ms, created_at, blob} */
  function put(record) {
    return tx("readwrite", function (store) { store.put(record); }).then(function () { return record.media_id; });
  }

  function get(mediaId) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var req = db.transaction(STORE, "readonly").objectStore(STORE).get(mediaId);
        req.onsuccess = function () { resolve(req.result || null); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function remove(mediaId) {
    return tx("readwrite", function (store) { store.delete(mediaId); });
  }

  function count() {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var req = db.transaction(STORE, "readonly").objectStore(STORE).count();
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function clear() {
    return tx("readwrite", function (store) { store.clear(); });
  }

  root.FI_MEDIA = { put: put, get: get, remove: remove, count: count, clear: clear };
})(typeof self !== "undefined" ? self : this);
