/**
 * fi-supabase.js — Field-Insight 를 여러 사람이 실제로 주고받게 만드는 연결층
 *
 * 이 앱의 목적은 **현장 → 전문가 → 고객**으로 이슈가 넘어가는 것이다.
 * 자료가 각자 브라우저에만 있으면 넘길 상대가 없어 목적 자체가 성립하지 않는다.
 * 여기서는 이슈를 서버 표에 넣어 다른 사람이 이어받게 한다.
 *
 * ── 담는 방식 ────────────────────────────────────────────────────────────
 * 이슈 하나가 화면에서는 깊게 중첩된 객체다(원본·질문·결론·회신·감사이력…).
 * 그것을 표 여러 개로 완전히 쪼개면 화면 코드를 통째로 다시 써야 한다.
 * 그래서 **둘을 겹쳐 쓴다.**
 *   · 걸러 내고 지켜야 하는 값(상태·접수자·장비·코드)은 **진짜 컬럼**으로
 *     → RLS 와 상태 관문이 이 값들을 보고 판단한다
 *   · 나머지 전부는 `issue.structured` (jsonb) 에 통째로
 *     → 화면 코드는 받은 그대로 쓰면 되고 아무것도 잃지 않는다
 *
 * ── 상태를 한 칸씩 올리는 이유 ───────────────────────────────────────────
 * DB 의 `can_transition()` 은 **한 걸음씩만** 허용한다(건너뛰기 방지).
 * 그런데 화면은 접수 한 번에 DRAFT→SUBMITTED→ASSIGNED 까지 간다.
 * 그래서 목표 상태까지의 길을 찾아 **한 칸씩 UPDATE** 한다.
 * 한 번에 밀어 넣으면 트리거가 막고, 막는 것이 맞다.
 *
 * ── 저장 순서 ────────────────────────────────────────────────────────────
 *   ① 이슈 행 (지금 DB 에 있는 상태 그대로 두고 내용만 갱신)
 *   ② 결론·회신·해결확인 (관문이 보는 근거들)
 *   ③ 상태를 목표까지 한 칸씩
 * 순서를 바꾸면 "결론이 없으면 ANSWERED 로 갈 수 없습니다" 로 막힌다.
 */
(function (root) {
  'use strict';

  var CFG = root.APP_CONFIG || {};
  var client = null;
  var mode = 'demo';            // 'demo' | 'server'
  var me = null;                // { user_id, name, email, roles[] }
  var notifyFn = null;
  var snapshot = {};            // code → 마지막으로 서버에 보낸 JSON (바뀐 것만 보내려고)
  var dbIdByCode = {};          // 'ISSUE #1024' → issue.id (bigint)
  var dbStatusByCode = {};      // 서버에 지금 들어 있는 상태

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
    if (isError && root.alert) root.alert(msg);
  }

  /* ─────────────────────────────── 상태 경로 ─────────────────────────── */

  /**
   * from → to 까지 **한 칸씩 갈 수 있는 길**을 찾는다 (너비 우선).
   * 길이 없으면 null — 그때는 상태를 올리지 않고 내용만 갱신한다.
   */
  function pathTo(from, to) {
    var SM = root.FI && root.FI.statemachine;
    if (!SM) return null;
    if (from === to) return [];
    var seen = {}; seen[from] = true;
    var q = [[from, []]];
    while (q.length) {
      var cur = q.shift(), at = cur[0], via = cur[1];
      var nexts = (SM.TRANSITIONS[at] || []).concat(SM.GLOBAL_TARGETS);
      for (var i = 0; i < nexts.length; i++) {
        var n = nexts[i];
        if (seen[n]) continue;
        var next = via.concat([n]);
        if (n === to) return next;
        seen[n] = true;
        q.push([n, next]);
      }
    }
    return null;
  }

  /* ─────────────────────────────── 로그인 ────────────────────────────── */

  function signIn(email, password) {
    return db().auth.signInWithPassword({ email: email, password: password })
      .then(function (r) { if (r.error) throw r.error; return r.data; });
  }
  function signOut() {
    return db().auth.signOut().then(function () { me = null; });
  }
  function session() {
    return db().auth.getSession().then(function (r) { return r.data && r.data.session; });
  }

  /** app_user 에서 내 역할을 읽는다. 등록 안 됐으면 null — 화면이 그걸 알려 준다. */
  function loadMe() {
    return db().auth.getUser().then(function (r) {
      var u = r.data && r.data.user;
      if (!u) return null;
      return db().from('app_user').select('*').eq('user_id', u.id).maybeSingle()
        .then(function (p) {
          if (p.error) throw p.error;
          me = p.data ? {
            user_id: p.data.user_id, name: p.data.name,
            email: p.data.email || u.email, roles: p.data.roles || []
          } : { user_id: u.id, name: u.email, email: u.email, roles: [] };
          return me;
        });
    });
  }
  function whoami() { return me; }

  /* ─────────────────────────────── 읽기 ──────────────────────────────── */

  function codeOf(issue) { return 'ISSUE #' + issue.issue_id; }
  function noOf(code) { var m = /(\d+)\s*$/.exec(code || ''); return m ? parseInt(m[1], 10) : null; }

  /** 서버에서 받아 화면이 쓰던 모양 { issues, knowledge, next_no } 로 되돌린다. */
  function loadDb() {
    return Promise.all([
      db().from('issue').select('id, code, status, structured').order('id', { ascending: true }),
      db().from('knowledge').select('issue_id, title, root_cause, action, prevention, tags, created_at')
    ]).then(function (res) {
      var bad = res.filter(function (r) { return r.error; });
      if (bad.length) throw bad[0].error;

      var rows = res[0].data || [];
      snapshot = {}; dbIdByCode = {}; dbStatusByCode = {};
      var issues = [], maxNo = 1023;

      rows.forEach(function (r) {
        var issue = r.structured && typeof r.structured === 'object' ? r.structured : null;
        if (!issue || !issue.issue_id) return;      // 화면 밖에서 넣은 행은 건너뛴다
        // 상태의 정본은 **컬럼**이다. structured 안의 값은 흔적일 뿐이라 어긋날 수 있다.
        issue.status = r.status;
        issues.push(issue);
        dbIdByCode[r.code] = r.id;
        dbStatusByCode[r.code] = r.status;
        snapshot[r.code] = JSON.stringify(issue);
        if (issue.issue_id > maxNo) maxNo = issue.issue_id;
      });

      var kn = (res[1].data || []).map(function (k) {
        return {
          source_issue_id: noOf(''), verified: true, curated_by: null,
          reuse_count: 0, created_at: k.created_at,
          title: k.title, root_cause: k.root_cause, action: k.action,
          prevention: k.prevention, tags: k.tags || []
        };
      });

      return { issues: issues, knowledge: kn, next_no: maxNo + 1 };
    });
  }

  /* ─────────────────────────────── 첨부 ──────────────────────────────── */
  /**
   * 현장이 찍은 사진·녹음은 브라우저(IndexedDB)에만 있으면 **전문가에게 넘어가지
   * 않는다.** 이 앱은 넘기는 것이 목적이므로 원본을 서버에 올린다.
   *
   * 버킷은 비공개다 — 주소를 알아도 그냥은 못 받는다.
   * 볼 때마다 짧게 사는 **서명 주소**를 받아 <img>/<audio> 에 물린다.
   * 현장 사진에는 사업장·설비가 찍히므로 공개 버킷으로 두면 안 된다.
   */
  var BUCKET = 'field-insight';
  var signedCache = {};   // storage_path → { url, exp }

  function mediaPath(issueCode, mediaId, mime) {
    var ext = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
                 'video/mp4': 'mp4', 'video/webm': 'webm',
                 'audio/webm': 'webm', 'audio/mpeg': 'mp3', 'audio/wav': 'wav' })[mime] || 'bin';
    // 코드에 '#'·공백이 들어 있다 — 경로에 그대로 쓰면 주소가 깨진다
    var safe = String(issueCode).replace(/[^A-Za-z0-9_-]+/g, '-');
    return safe + '/' + mediaId + '.' + ext;
  }

  /** 이미 올라가 있으면 다시 올리지 않는다(upsert 라 덮어써도 안전하지만 헛일이다). */
  function uploadMedia(issueCode, rec) {
    if (!rec || !rec.blob) return Promise.resolve(null);
    var path = mediaPath(issueCode, rec.media_id, rec.mime);
    return db().storage.from(BUCKET)
      .upload(path, rec.blob, { contentType: rec.mime || 'application/octet-stream', upsert: true })
      .then(function (r) {
        if (r.error) throw r.error;
        return path;
      });
  }

  /**
   * 서명 주소를 받아 온다. 한 시간짜리라 캐시하되 **만료 5분 전에 새로 받는다** —
   * 딱 맞춰 두면 재생 도중 끊긴다.
   */
  function signedUrl(path) {
    var now = Date.now();
    var c = signedCache[path];
    if (c && c.exp - now > 5 * 60 * 1000) return Promise.resolve(c.url);
    return db().storage.from(BUCKET).createSignedUrl(path, 3600).then(function (r) {
      if (r.error) throw r.error;
      var url = r.data && (r.data.signedUrl || r.data.signedURL);
      signedCache[path] = { url: url, exp: now + 3600 * 1000 };
      return url;
    });
  }

  /** 이 이슈의 첨부 목록 (media_id → storage_path) */
  function attachmentPaths(issueCode) {
    var id = dbIdByCode[issueCode];
    if (id == null) return Promise.resolve({});
    return db().from('attachment').select('file_name, storage_path').eq('issue_id', id)
      .then(function (r) {
        if (r.error) throw r.error;
        var map = {};
        (r.data || []).forEach(function (a) { map[a.file_name] = a.storage_path; });
        return map;
      });
  }

  /* ─────────────────────────────── 쓰기 ──────────────────────────────── */

  function conclusionOf(issue) {
    var o = issue.expert_opinion;
    if (!o) return null;
    // 4필드는 비면 안 된다(DB 제약). 미확정이면 그 사유를 원인으로 적는다 —
    // 빈 문자열로 두면 저장이 통째로 실패하고 화면에는 이유가 안 보인다.
    var cause = o.cause_undetermined
      ? ('미확정 — ' + (o.cause_undetermined_reason_label || o.cause_undetermined_reason || '사유 미기재'))
      : [o.cause_system_label, o.cause_part_label].filter(Boolean).join(' / ');
    return {
      root_cause: cause || '미확정',
      action: (o.action_detail || o.action_type || '조치 미기재').trim(),
      evidence: (o.rationale_text || o.original_text || '근거 미기재').trim(),
      prevention: (o.prevention || '재발방지 미기재').trim()
    };
  }

  function replyOf(issue) {
    var c = issue.customer_response;
    if (!c) return null;
    return {
      body: c.simplified_response || c.technical_original || '(내용 없음)',
      approved_at: c.approved_at || null,
      sent_at: c.delivered_at || null
    };
  }

  function resolutionOf(issue) {
    var fb = (issue.feedback || []).filter(function (f) { return f.result; });
    if (!fb.length) return null;
    var last = fb[fb.length - 1];
    return { confirmed: last.result === 'resolved', comment: last.comment || null };
  }

  /** 이슈 한 건을 서버에 반영한다. 순서는 파일 머리말 참고. */
  function pushIssue(issue) {
    var code = codeOf(issue);
    var target = issue.status;
    var eq = issue.equipment_ref;

    var head = {
      code: code,
      domain: issue.domain || '정비',
      title: issue.title || code,
      raw_text: (issue.user_input && issue.user_input.original_text) || '',
      structured: issue,
      equipment: eq ? (eq.model + (eq.sn ? ' · SN ' + eq.sn : '')) : null,
      site: issue.site || null
    };
    // 새 이슈는 항상 DRAFT 로 넣는다. 목표 상태로 바로 넣으면 관문이 막는다 —
    // 결론·회신이 아직 안 들어갔기 때문이다. 상태는 ③단계에서 올린다.
    if (dbIdByCode[code] == null) head.status = 'DRAFT';

    var p = dbIdByCode[code] == null
      ? db().from('issue').insert(head).select('id, status').single()
      : db().from('issue').update(head).eq('id', dbIdByCode[code]).select('id, status').single();

    return p.then(function (r) {
      if (r.error) throw r.error;
      dbIdByCode[code] = r.data.id;
      dbStatusByCode[code] = r.data.status;
      var id = r.data.id;

      // ② 관문이 보는 근거들
      var jobs = [];
      var c = conclusionOf(issue);
      if (c) { c.issue_id = id; jobs.push(db().from('conclusion').upsert(c, { onConflict: 'issue_id' })); }
      var rp = replyOf(issue);
      if (rp) { rp.issue_id = id; jobs.push(db().from('reply').upsert(rp, { onConflict: 'issue_id' })); }
      var rs = resolutionOf(issue);
      if (rs) { rs.issue_id = id; jobs.push(db().from('resolution').upsert(rs, { onConflict: 'issue_id' })); }

      // 첨부 — 원본은 Storage 로, 참조는 attachment 표로.
      // 여기서 올려 두어야 전문가가 다른 기기에서 열어도 사진·녹음이 보인다.
      var atts = (issue.attachments || []).filter(function (a) { return a.media_id; });
      if (atts.length && root.FI_MEDIA) {
        jobs.push(Promise.all(atts.map(function (a) {
          return root.FI_MEDIA.get(a.media_id).then(function (rec) {
            if (!rec || !rec.blob) return null;            // 이 기기에 원본이 없다(남이 올린 것)
            return uploadMedia(code, rec).then(function (path) {
              return db().from('attachment').upsert({
                issue_id: id, kind: a.kind === 'voice' ? 'audio' : (a.kind || 'file'),
                file_name: a.media_id, storage_path: path, size_bytes: a.size || null
              }, { onConflict: 'issue_id,file_name' });
            });
          }).catch(function () { return null; });          // 첨부 하나가 실패해도 이슈 저장은 살린다
        })).then(function () { return { error: null }; }));
      }

      // 질문은 최대 3개 — 있으면 같이 남긴다(근거 점프에 쓰인다)
      var qs = (issue.questions || []).slice(0, 3).map(function (q, i) {
        return { issue_id: id, seq: i + 1, question: q.text || q.question || String(q), answer: q.answer || null };
      });
      if (qs.length) jobs.push(db().from('question').upsert(qs, { onConflict: 'issue_id,seq' }));

      return Promise.all(jobs).then(function (rr) {
        var e = rr.filter(function (x) { return x && x.error; });
        if (e.length) throw e[0].error;
        return id;
      });
    }).then(function (id) {
      // ③ 상태를 한 칸씩
      var from = dbStatusByCode[code];
      if (from === target) return id;
      var steps = pathTo(from, target);
      if (!steps || !steps.length) return id;      // 길이 없으면 내용만 갱신한 채로 둔다
      var chain = Promise.resolve();
      steps.forEach(function (st) {
        chain = chain.then(function () {
          return db().from('issue').update({ status: st }).eq('id', id).select('status').single()
            .then(function (r) {
              if (r.error) throw r.error;
              dbStatusByCode[code] = r.data.status;
            });
        });
      });
      return chain.then(function () { return id; });
    }).then(function (id) {
      // Knowledge — 고객이 확인한 사례만. DB 트리거가 한 번 더 막는다.
      if (issue.status === 'KNOWLEDGE_READY' && issue.knowledge_entry) {
        var c2 = conclusionOf(issue) || {};
        return db().from('knowledge').upsert({
          issue_id: id,
          title: issue.title || codeOf(issue),
          symptom: (issue.user_input && issue.user_input.original_text) || null,
          root_cause: c2.root_cause || '미확정',
          action: c2.action || '조치 미기재',
          prevention: c2.prevention || null
        }, { onConflict: 'issue_id' }).then(function (r) {
          if (r.error) throw r.error;
          return id;
        });
      }
      return id;
    }).then(function (id) {
      snapshot[code] = JSON.stringify(issue);
      return id;
    });
  }

  /** 바뀐 이슈만 보낸다. 전부 보내면 글자 하나 고칠 때마다 표 전체를 다시 쓴다. */
  function saveDb(appDb) {
    var changed = (appDb.issues || []).filter(function (it) {
      return JSON.stringify(it) !== snapshot[codeOf(it)];
    });
    if (!changed.length) return Promise.resolve(0);
    var chain = Promise.resolve();
    changed.forEach(function (it) { chain = chain.then(function () { return pushIssue(it); }); });
    return chain.then(function () { return changed.length; })
      .catch(function (err) {
        var msg = (err && (err.message || err.hint)) || String(err);
        notify('서버에 저장하지 못했습니다 — ' + msg +
               '\n화면의 값은 아직 서버에 반영되지 않았습니다.', true);
        throw err;
      });
  }

  function setMode(m) { mode = m; }
  function getMode() { return mode; }

  root.FISupabase = {
    available: available, client: db,
    signIn: signIn, signOut: signOut, session: session, loadMe: loadMe, whoami: whoami,
    loadDb: loadDb, saveDb: saveDb, pathTo: pathTo,
    uploadMedia: uploadMedia, signedUrl: signedUrl,
    attachmentPaths: attachmentPaths, mediaPath: mediaPath,
    conclusionOf: conclusionOf, replyOf: replyOf, resolutionOf: resolutionOf,
    mode: getMode, setMode: setMode, onNotify: onNotify
  };
})(typeof self !== 'undefined' ? self : this);
