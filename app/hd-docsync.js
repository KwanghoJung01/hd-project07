/**
 * hd-docsync.js — 팀이 같은 자료를 보게 하는 가장 단순한 방법
 *
 * 이 파일은 앱이 이미 localStorage 에 넣던 **JSON 문서 하나를 통째로** 서버에 두고
 * 팀원이 같은 것을 보게 한다. 앱의 데이터 구조를 바꾸지 않으므로 붙이기 쉽다.
 *
 * 언제 이걸 쓰나
 *   팀 내부 도구 — 팀원끼리 어차피 서로 다 보는 화면.
 *   (업무공유 대시보드, 팀 포털, 이슈 워크플로 같은 것)
 *
 * 언제 쓰면 안 되나
 *   **사람마다 볼 수 있는 범위가 달라야 하는 화면.**
 *   협력업체 포털처럼 "남의 자료가 보이면 안 되는" 곳에서는 쓸 수 없다.
 *   문서 하나를 통째로 내려받으므로 모두가 모든 것을 갖게 된다.
 *   그런 화면은 행 단위 표 + RLS 로 가야 한다.
 *
 * 동시 편집
 *   마지막에 저장한 사람이 이긴다. 다만 **조용히 덮어쓰지는 않는다.**
 *   내가 받아 온 버전과 서버 버전이 다르면 저장을 멈추고 알린다.
 *   두 사람이 같은 시간에 고쳐 한쪽 작업이 사라지는 것이 이 방식의 유일한 위험인데,
 *   그것을 눈에 보이게 만드는 것이 이 검사의 목적이다.
 */
(function (root) {
  'use strict';

  var CFG = root.APP_CONFIG || {};
  var TABLE = 'workspace';
  var client = null;
  var docId = null;
  var version = null;      // 마지막으로 내가 받아 온 버전
  var mode = 'demo';
  var notifyFn = null;
  var saveTimer = null;
  var pending = null;

  function available() {
    return !!(CFG.USE_SUPABASE && CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY
      && root.supabase && typeof root.supabase.createClient === 'function');
  }

  function db() {
    if (client) return client;
    client = root.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true }
    });
    return client;
  }

  function onNotify(fn) { notifyFn = fn; }
  function notify(msg, isError) {
    if (notifyFn) { try { notifyFn(msg, isError); return; } catch (e) {} }
    if (isError) { try { root.alert(msg); } catch (e) {} }
  }

  function banner(state, detail) {
    var el = root.document && root.document.getElementById('hd-conn-banner');
    if (!el) {
      if (!root.document || !root.document.body) return;
      el = root.document.createElement('div');
      el.id = 'hd-conn-banner';
      el.setAttribute('role', 'status');
      root.document.body.insertBefore(el, root.document.body.firstChild);
    }
    var map = {
      connecting: ['서버에서 팀 자료를 받는 중…', '#e8edf3', '#334155'],
      synced:     ['팀 공용 자료입니다 — 저장하면 팀원 모두에게 반영됩니다.', '#e3f4ec', '#0a6045'],
      conflict:   ['다른 사람이 먼저 저장했습니다. 새로고침해 최신 자료를 받은 뒤 다시 입력하세요.', '#fdeae7', '#c8341f'],
      demo:       ['이 브라우저에만 저장됩니다 — 팀원에게는 보이지 않고, 브라우저를 정리하면 사라집니다.', '#fdf4e3', '#7a4f00']
    };
    var m = map[state] || map.demo;
    el.style.cssText = 'padding:8px 16px;font-size:13px;line-height:1.5;text-align:center;'
      + 'background:' + m[1] + ';color:' + m[2] + ';border-bottom:1px solid rgba(0,0,0,.08)';
    el.textContent = m[0] + (detail ? ' ' + detail : '');
    syncOffsets();
  }

  /**
   * 띠와 헤더의 **실제 높이**를 재서 CSS 변수로 알려 준다.
   *
   * 화면 위에 붙박이(position:fixed)로 놓인 것들은 보통 `top: 52px` 처럼
   * 헤더 높이를 숫자로 박아 둔다. 그 위에 띠가 하나 끼어들거나 헤더 여백이
   * 바뀌면 그 숫자가 틀려져 **붙박이 요소가 헤더를 덮는다.**
   * 실제로 hd-project05 의 왼쪽 메뉴가 그렇게 덮였다.
   * 숫자를 고쳐 박는 대신 잰 값을 넘겨, 무엇이 바뀌어도 따라오게 한다.
   */
  function syncOffsets() {
    if (!root.document || !root.document.documentElement) return;
    var el = root.document.getElementById('hd-conn-banner');
    var header = root.document.querySelector('body > header');
    var bh = el ? Math.round(el.getBoundingClientRect().height) : 0;
    var hh = header ? Math.round(header.getBoundingClientRect().height) : 0;
    var st = root.document.documentElement.style;
    st.setProperty('--hd-banner-h', bh + 'px');
    st.setProperty('--hd-header-h', hh + 'px');
    st.setProperty('--hd-chrome-h', (bh + hh) + 'px');
  }

  // 글꼴이 늦게 오거나 창 크기가 바뀌면 높이도 바뀐다
  if (root.addEventListener) {
    root.addEventListener('resize', function () { syncOffsets(); });
    if (root.document && root.document.fonts && root.document.fonts.ready) {
      root.document.fonts.ready.then(function () { syncOffsets(); });
    }
  }


  /**
   * 문서를 받아 온다. 없으면 지금 브라우저에 있던 것으로 처음 한 번 올린다.
   * @param {object} opts { id, initial, onReady(doc), onFallback(err) }
   */
  function boot(opts) {
    var o = opts || {};
    docId = o.id || 'default';

    if (!available()) {
      mode = 'demo';
      banner('demo');
      if (o.onFallback) o.onFallback(null);
      return;
    }
    banner('connecting');

    db().from(TABLE).select('doc, version').eq('id', docId).maybeSingle()
      .then(function (r) {
        if (r.error) throw r.error;
        mode = 'synced';
        if (r.data) {
          version = r.data.version;
          banner('synced');
          if (o.onReady) o.onReady(r.data.doc);
          return;
        }
        // 아직 아무도 안 올렸다 — 지금 이 브라우저에 있는 것을 씨앗으로 올린다
        return db().from(TABLE)
          .insert({ id: docId, doc: o.initial || {}, version: 1 })
          .then(function (ins) {
            if (ins.error) throw ins.error;
            version = 1;
            banner('synced', '(이 브라우저의 자료를 팀 공용으로 처음 올렸습니다)');
            if (o.onReady) o.onReady(o.initial || {});
          });
      })
      .catch(function (err) {
        mode = 'demo';
        var hint = /relation .* does not exist|schema cache/i.test((err && err.message) || '')
          ? ' supabase/schema.sql 을 SQL Editor 에서 실행했는지 확인하세요.'
          : '';
        banner('demo', '(연결 실패: ' + ((err && err.message) || err) + ')' + hint);
        if (o.onFallback) o.onFallback(err);
      });
  }

  /**
   * 저장. 짧은 시간에 여러 번 불려도 마지막 것 한 번만 보낸다.
   * (입력할 때마다 보내면 요청이 쏟아지고 충돌 검사도 무의미해진다)
   */
  function save(doc, delayMs) {
    if (mode !== 'synced') return;
    pending = doc;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, delayMs === undefined ? 600 : delayMs);
  }

  function flush() {
    if (mode !== 'synced' || pending === null) return Promise.resolve();
    var doc = pending;
    pending = null;
    var next = (version || 0) + 1;

    // ⚠ 버전이 내가 받아 온 것과 같을 때만 쓴다.
    //    그 사이 다른 사람이 저장했다면 조건에 걸려 0행이 바뀌고, 아래에서 알린다.
    return db().from(TABLE)
      .update({ doc: doc, version: next, updated_at: new Date().toISOString() })
      .eq('id', docId).eq('version', version)
      .select('version')
      .then(function (r) {
        if (r.error) throw r.error;
        if (!r.data || !r.data.length) {
          banner('conflict');
          notify('다른 사람이 먼저 저장해 이번 변경을 반영하지 못했습니다.\n'
               + '새로고침해 최신 자료를 받은 뒤 다시 입력해 주세요.', true);
          return;
        }
        version = r.data[0].version;
        banner('synced');
      })
      .catch(function (err) {
        notify('저장하지 못했습니다: ' + ((err && err.message) || err)
             + '\n화면의 값은 아직 서버에 반영되지 않았습니다.', true);
      });
  }

  root.HDDoc = {
    available: available,
    mode: function () { return mode; },
    boot: boot,
    save: save,
    flush: flush,
    onNotify: onNotify,
    banner: banner
  };
})(typeof self !== 'undefined' ? self : this);
