/**
 * Field-Insight MVP-1 — 단일 페이지 앱 (Phase 1: 브라우저 + 로컬 JS + Mock AI + LocalStorage)
 *
 * 화면: 접수자 C-01~05 / 전문가 E-01~05, 역할은 user.roles[] + 모드 토글(계정 분리 없음)
 * 저장: LocalStorage (Store 계층만 교체하면 Phase 2에서 서버/DB 전환 가능)
 */
(function () {
  "use strict";

  var S = window.FI_SCHEMA;
  var E = window.FI;
  var adapter = E.mockai.createMockAdapter(S.parts);
  var MNT = S.maintenance;

  /**
   * 지금 쓰고 있는 사람.
   * 데모 모드에서는 아래 값 그대로(계정 없음), 서버 모드에서는 **로그인한 계정**과
   * app_user 표의 역할로 갈아 끼운다. 역할이 하나면 모드 토글도 그 하나만 남는다 —
   * 접수자에게 전문가 화면을 열어 두면 "볼 수는 있는데 저장은 막히는" 상태가 되어
   * 무엇이 잘못됐는지 알 수 없다.
   */
  var USER = { name: "김현장", roles: ["reporter", "expert"] };

  /** 자유 입력(현상 설명·전문가 자유 서술) 최대 길이 */
  var MAX_FREE_TEXT = 5000;

  /** 보유장비 목록 (MNT-12 장비 식별 — 질문 예산을 소모하지 않는 자동 획득, P5) */
  var EQUIPMENTS = [
    { model: "HX220A", sn: "3421", hours: 3410 },
    { model: "HX300L", sn: "1102", hours: 5230 },
    { model: "HW250", sn: "7789", hours: 820 },
    { model: "DX140W", sn: "0087", hours: 1250 }
  ];

  /* ────────────────────────── 저장 계층 ──────────────────────────
     데모 모드 : 이 브라우저에만 (localStorage)
     서버 모드 : Supabase — 현장이 접수한 것을 전문가가 이어받는다
     둘 다 화면 코드는 그대로다. 저장 위치만 다르다. */
  var SERVER = false;

  var Store = {
    KEY: "field_insight_db_v1",
    empty: function () { return { issues: [], knowledge: [], next_no: 1024 }; },
    load: function () {
      try {
        var raw = localStorage.getItem(this.KEY);
        return raw ? JSON.parse(raw) : this.empty();
      } catch (e) { return this.empty(); }
    },
    save: function (db) {
      // 브라우저에는 항상 남긴다 — 서버가 잠깐 안 되어도 입력한 것이 사라지지 않게.
      try { localStorage.setItem(this.KEY, JSON.stringify(db)); } catch (e) { /* 저장 불가 환경 */ }
      // 서버 모드면 바뀐 이슈만 올린다. 실패하면 조용히 넘기지 않고 띠에 적는다.
      if (SERVER && window.FISupabase) {
        window.FISupabase.saveDb(db).catch(function () { /* 알림은 어댑터가 한다 */ });
      }
    },
    reset: function () {
      try { localStorage.removeItem(this.KEY); } catch (e) {}
    }
  };

  var db = Store.load();

  /* 설정(2차 고도화): STT 엔진·비전 제공사·API 키 — 키는 localStorage 에만 보관, 서버 전송 없음 */
  var Settings = {
    KEY: "field_insight_settings_v1",
    defaults: { stt_engine: "webspeech", whisper_key: "", vision_provider: "none", vision_key: "", vision_model: "" },
    load: function () {
      try {
        var raw = localStorage.getItem(this.KEY);
        var s = raw ? JSON.parse(raw) : {};
        var out = {};
        for (var k in this.defaults) out[k] = s[k] != null ? s[k] : this.defaults[k];
        return out;
      } catch (e) {
        var d = {};
        for (var k2 in this.defaults) d[k2] = this.defaults[k2];
        return d;
      }
    },
    save: function (s) {
      try { localStorage.setItem(this.KEY, JSON.stringify(s)); } catch (e) {}
    }
  };
  var settings = Settings.load();

  var state = {
    mode: "reporter",       // reporter | expert
    view: "c04",            // reporter: c01/c02/c03/c04/cdetail/safety · expert: e01/edetail
    draft: null,            // 접수 진행 중 세션(DRAFT)
    current: null,          // 열려 있는 issue_id
    hl: null,               // 근거 하이라이트 {input_id, start, end}
    partQuery: "",
    opinionForm: null,      // E-04 작업 중 폼
    rewriteText: null,      // E-05 편집 중 재작성문
    rec: null,              // 녹음 세션 {mr, stream, chunks, startTs, stt}
    draftMedia: [],         // C-01 첨부 목록 [{media_id, kind, name, size, duration_ms, transcript_segments}]
    mediaURLs: {},          // media_id → objectURL 캐시
    activeSeg: null,        // 근거 점프로 강조된 음성 세그먼트 {media_id, index}
    settingsOpen: false,
    busy: null,             // 비동기 작업 안내문(미디어 분석 중 등)
    notice: null            // 일회성 안내문(STT 미지원/실패 등)
  };

  /* ────────────────────────── 유틸 ────────────────────────── */
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function now() { return new Date().toISOString(); }
  function fmt(ts) {
    if (!ts) return "";
    var d = new Date(ts);
    var p = function (n) { return (n < 10 ? "0" : "") + n; };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }
  function elapsed(ts) {
    var h = Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 3600000));
    if (h < 1) return "1시간 미만";
    if (h < 24) return h + "시간 경과";
    return Math.round(h / 24) + "일 경과";
  }
  function eqLabel(eq) {
    return eq ? eq.model + " · SN " + eq.sn + " · " + eq.hours.toLocaleString("ko-KR") + "h" : "장비 미지정";
  }
  function getIssue(no) {
    return db.issues.filter(function (i) { return i.issue_id === no; })[0] || null;
  }
  function scenarioOf(issue) {
    return (MNT.scenarios || []).filter(function (s) { return s.scenario_id === issue.scenario_id; })[0] || MNT.scenarios[0];
  }
  function reqOf(id) {
    return MNT.requirements.filter(function (r) { return r.requirement_id === id; })[0];
  }
  function collectedOf(issueOrDraft, reqId) {
    return (issueOrDraft.collected || []).filter(function (c) { return c.requirement_id === reqId; })[0] || null;
  }
  function notify(issue, text) {
    issue.notifications.push({ ts: now(), text: text }); // FR-22 진행 상태 알림
  }
  function sufficiencyOf(issue) {
    var g = E.gap.analyze(MNT, scenarioOf(issue), issue.collected);
    return Math.round(g.sufficiency * 100);
  }
  function makeTitle(collected) {
    var cond = null, sym = null;
    collected.forEach(function (c) {
      if (c.value_state !== "known") return;
      if (c.requirement_id === "MNT-03") cond = c.value;
      if (c.requirement_id === "MNT-01") sym = c.value;
    });
    if (cond && sym) return cond + " 시 " + sym;
    if (sym) return sym + " 현상";
    return "현장 이슈";
  }
  /** 확보 값 교체(동일 requirement 항목 대체) — 원본(UserInput)은 절대 수정하지 않는다(DP-1) */
  function upsertCollected(target, item) {
    var idx = -1;
    target.collected.forEach(function (c, i) { if (c.requirement_id === item.requirement_id) idx = i; });
    if (idx >= 0) target.collected[idx] = item; else target.collected.push(item);
  }

  /* ────────────────────────── 미디어·녹음·STT (2차 고도화) ────────────────────────── */

  function newMediaId() {
    return "m-" + Date.now() + "-" + Math.floor(Math.random() * 1e6);
  }

  function mediaURL(mediaId) { return state.mediaURLs[mediaId] || null; }

  /**
   * 렌더 후 [data-media-src] 요소에 실제 미디어를 물린다.
   *
   * 이 기기에 원본이 있으면(내가 찍은 것) IndexedDB Blob 을 그대로 쓴다.
   * **없으면 — 남이 올린 것이다.** 서버 모드에서는 비공개 버킷의 서명 주소를 받아 온다.
   * 이 갈래가 없으면 전문가 화면에서 현장 사진이 통째로 비어 보인다.
   */
  function hydrateMedia() {
    var els = root.querySelectorAll("[data-media-src]");
    Array.prototype.forEach.call(els, function (el) {
      var id = el.getAttribute("data-media-src");
      var cached = mediaURL(id);
      if (cached) { if (el.src !== cached) el.src = cached; return; }
      window.FI_MEDIA.get(id).then(function (rec) {
        if (rec && rec.blob) {
          var url = URL.createObjectURL(rec.blob);
          state.mediaURLs[id] = url;
          el.src = url;
          return;
        }
        return hydrateFromServer(id, el);
      }).catch(function () { return hydrateFromServer(id, el); });
    });
  }

  /** 이 기기에 없는 첨부를 서버에서 받아 온다 (서버 모드에서만) */
  function hydrateFromServer(mediaId, el) {
    if (!SERVER || !window.FISupabase) return;
    var issue = state.current != null ? getIssue(state.current) : null;
    if (!issue) return;
    return window.FISupabase.attachmentPaths("ISSUE #" + issue.issue_id)
      .then(function (map) {
        var path = map[mediaId];
        if (!path) return;
        return window.FISupabase.signedUrl(path).then(function (url) {
          if (!url) return;
          state.mediaURLs[mediaId] = url;
          el.src = url;
        });
      })
      .catch(function () { /* 못 받아도 화면은 그대로 — 나머지는 보인다 */ });
  }

  /** 음성 근거 점프: 해당 오디오를 세그먼트 시작 지점부터 재생 */
  function playAudioSegment(mediaId, ms) {
    var tryPlay = function (attempt) {
      var audio = root.querySelector('audio[data-media-src="' + mediaId + '"]');
      if (audio && audio.src) {
        var seek = function () {
          try {
            audio.currentTime = Math.max(0, (ms || 0) / 1000);
            audio.play().catch(function () {});
          } catch (e) {}
        };
        if (audio.readyState >= 1) seek();
        else audio.addEventListener("loadedmetadata", seek, { once: true });
      } else if (attempt < 10) {
        setTimeout(function () { tryPlay(attempt + 1); }, 150);
      }
    };
    tryPlay(0);
  }

  function sttUnsupportedNotice() {
    return "이 브라우저는 실시간 음성 인식(Web Speech)을 지원하지 않습니다. " +
      "크롬/엣지를 사용하거나, ⚙ 설정에서 Whisper API 키를 등록하면 녹음 파일로 전사할 수 있습니다. " +
      "녹음 자체는 원본 증거로 첨부됩니다.";
  }

  /** 녹음 시작: MediaRecorder + (가능하면) Web Speech 실시간 전사 */
  function startRecording() {
    if (state.rec) return;
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      state.notice = "이 브라우저는 음성 녹음을 지원하지 않습니다. 텍스트로 입력해 주세요.";
      render();
      return;
    }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      var mr = new MediaRecorder(stream);
      var rec = state.rec = {
        mr: mr, stream: stream, chunks: [], startTs: Date.now(), stt: null, interim: ""
      };
      mr.ondataavailable = function (e) { if (e.data && e.data.size) rec.chunks.push(e.data); };
      mr.onstop = function () { finishRecording(rec); };

      // 실시간 STT (Web Speech) — 세그먼트 타임스탬프는 녹음 시작 기준 ms
      if (settings.stt_engine === "webspeech" && E.stt.supported(window)) {
        var engine = E.stt.createWebSpeechSTT({});
        engine.onsegment = function (seg) { appendTranscriptText(seg.text); };
        engine.oninterim = function (t) {
          rec.interim = t;
          var el = document.getElementById("rec-interim");
          if (el) el.textContent = t;
        };
        engine.onerror = function () { /* 네트워크 오류 등 — 녹음은 계속 */ };
        rec.stt = engine;
        try { engine.start(); } catch (e) { rec.stt = null; }
      } else if (settings.stt_engine === "webspeech") {
        state.notice = sttUnsupportedNotice();
      }
      mr.start();
      rec.timerId = setInterval(function () {
        var el = document.getElementById("rec-timer");
        if (el) el.textContent = E.media.formatDuration((Date.now() - rec.startTs) / 1000);
      }, 300);
      render();
    }).catch(function (err) {
      state.notice = "마이크 권한이 필요합니다: " + err.message;
      render();
    });
  }

  function stopRecording() {
    var rec = state.rec;
    if (!rec) return;
    if (rec.stt) rec.stt.stop();
    try { rec.mr.stop(); } catch (e) { finishRecording(rec); }
  }

  /** 녹음 종료 → Blob 저장(IndexedDB, 원본 불변 DP-1) + 전사 세그먼트 첨부 */
  function finishRecording(rec) {
    if (rec.timerId) clearInterval(rec.timerId);
    rec.stream.getTracks().forEach(function (t) { t.stop(); });
    var blob = new Blob(rec.chunks, { type: rec.mr.mimeType || "audio/webm" });
    var durationMs = Date.now() - rec.startTs;
    var segments = rec.stt ? rec.stt.segments.slice() : [];
    state.rec = null;

    var check = E.media.validateFile({ name: "recording.webm", type: blob.type || "audio/webm", size: blob.size });
    if (!check.ok) {
      state.notice = check.error;
      render();
      return;
    }
    var mediaId = newMediaId();
    var name = "음성 녹음 " + (state.draftMedia.filter(function (m) { return m.kind === "audio"; }).length + 1);
    window.FI_MEDIA.put({
      media_id: mediaId, kind: "audio", name: name, mime: blob.type || "audio/webm",
      size: blob.size, duration_ms: durationMs, created_at: now(), blob: blob
    }).then(function () {
      var att = {
        media_id: mediaId, kind: "audio", name: name, mime: blob.type || "audio/webm",
        size: blob.size, duration_ms: durationMs, transcript_segments: segments
      };
      state.draftMedia.push(att);
      // Whisper 경로: 녹음 파일 업로드 전사 (사용자 키가 있을 때만)
      if (!segments.length && settings.stt_engine === "whisper" && settings.whisper_key) {
        state.busy = "음성 전사 중…(Whisper)";
        render();
        E.stt.createWhisperSTT({ apiKey: settings.whisper_key })
          .transcribe(blob, "recording.webm", durationMs)
          .then(function (segs) {
            att.transcript_segments = segs;
            segs.forEach(function (s) { appendTranscriptText(s.text); });
          })
          .catch(function (err) { state.notice = "음성 전사 실패: " + err.message + " (녹음은 첨부되었습니다)"; })
          .then(function () { state.busy = null; render(); });
      } else if (!segments.length && settings.stt_engine === "whisper") {
        state.notice = "Whisper API 키가 없습니다. ⚙ 설정에서 키를 입력하면 자동 전사됩니다.";
      }
      render();
    }).catch(function (err) {
      state.notice = "미디어 저장 실패: " + err.message;
      render();
    });
  }

  /** 전사 텍스트를 입력란에 이어 붙인다 (STT → 텍스트 자동 삽입, 재렌더에도 유지) */
  function appendTranscriptText(text) {
    var t = String(text || "").trim();
    if (!t) return;
    var ta = document.getElementById("input-text");
    var cur = ta ? ta.value : (state.c01Text || "");
    var next = cur.trim() ? cur.replace(/\s+$/, "") + " " + t : t;
    state.c01Text = next;
    if (ta) ta.value = next;
  }

  /** 이미지/영상 파일 첨부 (용량 제한: 영상 50MB — engine/media.js LIMITS) */
  function attachFile(file) {
    var check = E.media.validateFile({ name: file.name, type: file.type, size: file.size });
    if (!check.ok) {
      state.notice = check.error;
      render();
      return;
    }
    var mediaId = newMediaId();
    var record = {
      media_id: mediaId, kind: check.kind, name: file.name, mime: file.type,
      size: file.size, duration_ms: null, created_at: now(), blob: file
    };
    var finish = function (durationMs) {
      record.duration_ms = durationMs;
      window.FI_MEDIA.put(record).then(function () {
        state.draftMedia.push({
          media_id: mediaId, kind: check.kind, name: file.name, mime: file.type,
          size: file.size, duration_ms: durationMs, transcript_segments: []
        });
        render();
      }).catch(function (err) {
        state.notice = "미디어 저장 실패: " + err.message;
        render();
      });
    };
    if (check.kind === "video") {
      var v = document.createElement("video");
      v.preload = "metadata";
      v.onloadedmetadata = function () {
        var d = isFinite(v.duration) ? Math.round(v.duration * 1000) : null;
        URL.revokeObjectURL(v.src);
        finish(d);
      };
      v.onerror = function () { finish(null); };
      v.src = URL.createObjectURL(file);
    } else {
      finish(null);
    }
  }

  function removeDraftMedia(mediaId) {
    state.draftMedia = state.draftMedia.filter(function (m) { return m.media_id !== mediaId; });
    window.FI_MEDIA.remove(mediaId).catch(function () {});
  }

  /* ── 선택 정밀 모드: 이미지/영상 프레임 비전 분석 (키 입력 시에만) ── */

  function blobToDataURI(blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(fr.error); };
      fr.readAsDataURL(blob);
    });
  }

  /** 영상에서 프레임 최대 3장 캡처(canvas) → dataURI[] */
  function captureVideoFrames(blob, durationMs) {
    return new Promise(function (resolve) {
      var times = E.media.frameTimes((durationMs || 0) / 1000, 3);
      var v = document.createElement("video");
      v.preload = "auto";
      v.muted = true;
      v.src = URL.createObjectURL(blob);
      var canvas = document.createElement("canvas");
      var out = [];
      var i = 0;
      var fail = setTimeout(function () { done(); }, 8000);
      function done() {
        clearTimeout(fail);
        URL.revokeObjectURL(v.src);
        resolve(out);
      }
      function next() {
        if (i >= times.length) return done();
        v.currentTime = times[i++];
      }
      v.onloadeddata = function () {
        canvas.width = Math.min(v.videoWidth || 640, 1024);
        canvas.height = Math.round(canvas.width * ((v.videoHeight || 480) / (v.videoWidth || 640)));
        next();
      };
      v.onseeked = function () {
        try {
          canvas.getContext("2d").drawImage(v, 0, 0, canvas.width, canvas.height);
          out.push(canvas.toDataURL("image/jpeg", 0.7));
        } catch (e) {}
        next();
      };
      v.onerror = function () { done(); };
    });
  }

  function visionAdapter() {
    return E.aivision.createVisionAdapter({
      provider: settings.vision_provider,
      api_key: settings.vision_key,
      model: settings.vision_model || undefined
    });
  }

  /** 첨부 이미지 + 영상 프레임 → 비전 분석. 실패해도 기본 경로(규칙 엔진)는 유지 */
  function analyzeDraftMedia(contextText) {
    var adapterV = visionAdapter();
    var visual = state.draftMedia.filter(function (m) { return m.kind === "image" || m.kind === "video"; });
    if (!adapterV || !visual.length) return Promise.resolve(null);
    var jobs = visual.map(function (m) {
      return window.FI_MEDIA.get(m.media_id).then(function (rec) {
        if (!rec || !rec.blob) return [];
        return m.kind === "image"
          ? blobToDataURI(rec.blob).then(function (uri) { return [uri]; })
          : captureVideoFrames(rec.blob, m.duration_ms);
      });
    });
    return Promise.all(jobs).then(function (lists) {
      var images = [];
      lists.forEach(function (l) { l.forEach(function (u) { if (images.length < 3) images.push(u); }); });
      if (!images.length) return null;
      return adapterV.analyzeMedia({ images: images, context: contextText });
    }).catch(function (err) {
      state.notice = "미디어 분석 실패(" + err.message + ") — 규칙 엔진 분석은 정상 동작합니다.";
      return null;
    });
  }

  /* ────────────────────────── 접수 흐름 로직 ────────────────────────── */

  /** C-01 → 분석: Intent/안전 감지 → 시나리오 → 추출(텍스트+미디어 단서) → 질문 생성 */
  function startAnalysis(text, equipment, mediaFindings) {
    var intentResult = E.intent.classify(text, S.domains);
    var inputId = "input-" + Date.now();

    // 안전 분기: 텍스트 위험 키워드(FR-05) + 미디어 분석 위험 신호(선택 정밀 모드) 연동
    var mediaHazards = (mediaFindings && mediaFindings.hazards) || [];
    if (intentResult.safety_flag || mediaHazards.length) {
      mediaHazards.forEach(function (h) {
        intentResult.safety_hits.push({ keyword: h + " (미디어 분석)", start: -1, end: -1 });
      });
      intentResult.safety_flag = true;
      state.draft = { text: text, equipment: equipment, intentResult: intentResult, input_id: inputId, mediaFindings: mediaFindings };
      state.view = "safety";
      return;
    }

    var scenario = E.gap.pickScenario(text, MNT);
    var collected = E.gap.extract(text, MNT, scenario, inputId);

    // 미디어 분석이 새 단서를 주면 미확보 요건에 inferred(0.6) 값으로 반영 → 질문 재산출에 반영(DecisionImpact 미확보도 변화)
    if (mediaFindings) {
      var mediaText = [mediaFindings.summary].concat(mediaFindings.observed || []).join(" ");
      var fromMedia = E.gap.extract(mediaText, MNT, scenario, "media-findings");
      fromMedia.forEach(function (mc) {
        var already = collected.some(function (c) { return c.requirement_id === mc.requirement_id; });
        if (already) return;
        mc.source_type = "inferred"; // 미디어에서 추론 — 확인 대상 후보
        mc.confidence = E.confidence.confidenceFor("inferred");
        mc.coverage = "partial";
        mc.evidence_ref = { input_id: null, type: "media", detail: "미디어 분석: " + (mc.evidence_ref.matched_text || "") };
        collected.push(mc);
      });
    }
    // MNT-12 장비 식별 — 시스템 자동 획득 (source=system, confidence 1.0)
    collected.push({
      requirement_id: "MNT-12", label: "장비 식별(모델/SN/가동시간)",
      value: eqLabel(equipment), value_state: "known", coverage: "full",
      source_type: "system", confidence: E.confidence.confidenceFor("system"),
      evidence_ref: { input_id: null, type: "system", detail: "보유장비 선택" }
    });
    var questions = E.question.generateQuestions(MNT, scenario, collected);

    state.draft = {
      text: text, equipment: equipment, input_id: inputId,
      intentResult: intentResult, scenario: scenario,
      collected: collected, questions: questions, qIndex: 0,
      mediaFindings: mediaFindings || null
    };
    state.view = questions.length ? "c02" : "c03";
  }

  /** C-02 답변 반영 */
  function answerQuestion(q, answer, skipped) {
    q.answer = skipped ? null : answer;
    q.answered_at = now();
    var d = state.draft;
    if (skipped) {
      upsertCollected(d, {
        requirement_id: q.requirement_id, label: q.label, value: null,
        value_state: "skipped", coverage: "full", source_type: "answered", confidence: null,
        evidence_ref: { input_id: null, type: "answer", question_id: q.question_id }
      });
    } else if (answer === E.question.UNKNOWN_OPTION) {
      upsertCollected(d, {
        requirement_id: q.requirement_id, label: q.label, value: null,
        value_state: "unknown", coverage: "full", source_type: "answered", confidence: null,
        evidence_ref: { input_id: null, type: "answer", question_id: q.question_id }
      });
    } else {
      upsertCollected(d, {
        requirement_id: q.requirement_id, label: q.label, value: answer,
        value_state: "known", coverage: "full",
        source_type: "answered", confidence: E.confidence.confidenceFor("answered"),
        evidence_ref: { input_id: null, type: "answer", question_id: q.question_id }
      });
    }
    d.qIndex++;
    if (d.qIndex >= d.questions.length) state.view = "c03";
  }

  /** C-03 → Issue 생성 (FR-10: 사용자 접수 시점에 확정) */
  function submitIssue(opts) {
    var d = state.draft;
    var no = db.next_no++;
    var issue = {
      issue_id: no,
      status: "DRAFT",
      title: makeTitle(d.collected),
      domain: d.intentResult.domain,
      intent: d.intentResult.intent,
      scenario_id: d.scenario ? d.scenario.scenario_id : null,
      safety_level: (opts && opts.safety) ? "긴급" : "일반",
      priority: (opts && opts.safety) ? "긴급" : "보통",
      equipment_ref: d.equipment,
      assignee_id: "expert-demo",
      linked_issues: [],
      /* DP-1/FR-03: 고객 원본은 불변 저장, AI 해석(collected)과 분리 */
      user_input: {
        input_id: d.input_id, input_type: state.draftMedia.length ? "multimodal" : "text",
        original_text: d.text, created_at: now(),
        metadata: d.equipment ? { model: d.equipment.model, sn: d.equipment.sn, hours: d.equipment.hours } : null
      },
      /* 첨부 미디어: Blob 은 IndexedDB(불변), Issue 에는 참조+전사만. 음성 전사는 최종 텍스트 char 위치를 매핑해 근거 점프에 사용 */
      attachments: state.draftMedia.map(function (m) {
        return {
          media_id: m.media_id,
          input_type: m.kind === "audio" ? "voice" : m.kind,
          kind: m.kind, name: m.name, mime: m.mime, size: m.size, duration_ms: m.duration_ms,
          transcript: m.kind === "audio" && (m.transcript_segments || []).length
            ? E.media.locateSegments(d.text, m.transcript_segments)
            : null
        };
      }),
      media_findings: d.mediaFindings || null,
      intent_result: d.intentResult,
      collected: d.collected,
      questions: d.questions || [],
      expert_checks: d.scenario ? E.question.expertCheckItems(MNT, d.scenario, d.collected) : [],
      ai_analysis: null,
      expert_opinion: null,
      customer_response: null,
      feedback: [],
      reopen_count: 0,
      pending_request: null,
      notifications: [],
      audit: [],
      knowledge_entry: null,
      created_at: now()
    };
    E.statemachine.appendAudit(issue, "issue_created",
      { domain: issue.domain, scenario: issue.scenario_id, safety: issue.safety_level }, "접수자");
    if (issue.attachments.length) {
      E.statemachine.appendAudit(issue, "media_attached", {
        count: issue.attachments.length,
        kinds: issue.attachments.map(function (a) { return a.kind; })
      }, "접수자");
    }
    if (issue.media_findings) {
      E.statemachine.appendAudit(issue, "media_analysis", {
        provider: issue.media_findings.provider, summary: issue.media_findings.summary
      }, "vision-ai");
    }
    E.statemachine.transition(issue, "SUBMITTED", { actor: "접수자", note: "사용자 접수" });
    notify(issue, "접수되었습니다 (#" + no + ") · 예상 회신 24시간");
    E.statemachine.transition(issue, "ASSIGNED", { actor: "system", note: "자동 배정: 전문가 데모 계정" });
    notify(issue, "담당 전문가가 확인 중입니다");
    db.issues.push(issue);
    Store.save(db);
    state.draft = null;
    state.draftMedia = [];
    state.c01Text = "";
    state.current = no;
    state.view = "cdetail";
    return issue;
  }

  /* ────────────────────────── 렌더링 ────────────────────────── */
  var root = document.getElementById("root");

  function render() {
    document.getElementById("mode-reporter").className = state.mode === "reporter" ? "active" : "";
    document.getElementById("mode-expert").className = state.mode === "expert" ? "active" : "";
    var html = "";
    if (state.mode === "reporter") {
      if (state.view === "c01") html = viewC01();
      else if (state.view === "c02") html = viewC02();
      else if (state.view === "c03") html = viewC03();
      else if (state.view === "safety") html = viewSafety();
      else if (state.view === "cdetail") html = viewCDetail();
      else html = viewC04();
    } else {
      if (state.view === "edetail") html = viewEDetail();
      else html = viewE01();
    }
    var banners = "";
    if (state.busy) banners += '<div class="notice" id="busy-banner">⏳ ' + esc(state.busy) + '</div>';
    if (state.notice) {
      banners += '<div class="warnbox" id="notice-banner"><div class="t">안내</div><p>' + esc(state.notice) + '</p>' +
        '<button class="ghost" data-action="dismiss-notice" style="margin-top:8px">확인</button></div>';
    }
    var overlay = state.rec ? viewRecordingOverlay() : "";
    var settingsHtml = state.settingsOpen ? viewSettings() : "";
    root.innerHTML = banners + settingsHtml + html + overlay;
    hydrateMedia();
    var mk = root.querySelector("mark.hl");
    if (mk) mk.scrollIntoView({ block: "center" });
  }

  /** 녹음 오버레이 — 화면 응시 최소화(어두운 배경 + 큰 정지 버튼 + 진행 표시) */
  function viewRecordingOverlay() {
    var rec = state.rec;
    var sttOn = !!(rec && rec.stt);
    return '' +
      '<div class="rec-overlay" id="rec-overlay">' +
      '<div class="rec-pulse">🎤</div>' +
      '<div class="rec-time" id="rec-timer">' + E.media.formatDuration((Date.now() - rec.startTs) / 1000) + '</div>' +
      '<div class="rec-interim" id="rec-interim">' + esc(rec.interim || (sttOn ? "말씀하세요 — 실시간으로 받아 적는 중" : "녹음 중 (이 브라우저는 실시간 전사 미지원)")) + '</div>' +
      '<button class="rec-stop" id="btn-record-stop" data-action="record-stop">■ 녹음 끝내기</button>' +
      '</div>';
  }

  /** ⚙ 설정 — STT 엔진 / 비전 제공사 / API 키 (키는 이 브라우저 localStorage 에만 저장) */
  function viewSettings() {
    return '' +
      '<section class="card" id="settings-view">' +
      '<h2>⚙ 설정</h2>' +
      '<p class="muted">API 키는 이 브라우저의 localStorage 에만 저장되며 접수 데이터와 함께 전송되지 않습니다. 키가 없으면 완전 오프라인 규칙 엔진으로 동작합니다.</p>' +
      '<label class="fld" for="set-stt">음성 인식(STT) 엔진</label>' +
      '<select id="set-stt">' +
      '<option value="webspeech"' + (settings.stt_engine === "webspeech" ? " selected" : "") + '>Web Speech API — 무료·키 불필요 (크롬/엣지, 네트워크 필요)</option>' +
      '<option value="whisper"' + (settings.stt_engine === "whisper" ? " selected" : "") + '>Whisper API — 녹음 파일 업로드 (API 키 필요)</option>' +
      '</select>' +
      '<label class="fld" for="set-whisper-key">Whisper API 키 (선택)</label>' +
      '<input type="text" id="set-whisper-key" placeholder="sk-…" value="' + esc(settings.whisper_key) + '">' +
      '<label class="fld" for="set-vision">미디어 정밀 분석(비전) 제공사 — 선택</label>' +
      '<select id="set-vision">' +
      '<option value="none"' + (settings.vision_provider === "none" ? " selected" : "") + '>사용 안 함 (기본 — 오프라인 규칙 엔진)</option>' +
      '<option value="claude"' + (settings.vision_provider === "claude" ? " selected" : "") + '>Claude API</option>' +
      '<option value="openai"' + (settings.vision_provider === "openai" ? " selected" : "") + '>OpenAI API</option>' +
      '</select>' +
      '<label class="fld" for="set-vision-key">비전 API 키</label>' +
      '<input type="text" id="set-vision-key" placeholder="API 키" value="' + esc(settings.vision_key) + '">' +
      '<label class="fld" for="set-vision-model">비전 모델 (비우면 제공사 기본값)</label>' +
      '<input type="text" id="set-vision-model" placeholder="기본값 사용" value="' + esc(settings.vision_model) + '">' +
      '<div class="row-actions">' +
      '<button class="primary" data-action="save-settings" style="margin-top:0">저장</button>' +
      '<button class="ghost" data-action="close-settings">닫기</button>' +
      '</div>' +
      '</section>';
  }

  /** C-01/C-03 공용: 첨부 미디어 목록 */
  function attachmentListHTML(items, removable) {
    if (!items.length) return "";
    return '<div class="att-list" id="draft-attachments">' + items.map(function (m) {
      var icon = m.kind === "audio" ? "🔊" : m.kind === "image" ? "🖼" : "🎬";
      var meta = E.media.formatBytes(m.size) +
        (m.duration_ms ? " · " + E.media.formatDuration(m.duration_ms / 1000) : "");
      var preview = "";
      if (m.kind === "image") preview = '<img class="att-thumb" data-media-src="' + esc(m.media_id) + '" alt="' + esc(m.name) + '">';
      if (m.kind === "audio") preview = '<audio controls preload="metadata" data-media-src="' + esc(m.media_id) + '"></audio>';
      if (m.kind === "video") preview = '<video controls preload="metadata" class="att-video" data-media-src="' + esc(m.media_id) + '"></video>';
      var stt = (m.transcript_segments || []).length
        ? '<span class="badge">전사 ' + m.transcript_segments.length + '구간</span>' : "";
      return '<div class="att-item" data-kind="' + m.kind + '">' +
        '<div class="att-head">' + icon + ' <b>' + esc(m.name) + '</b> <span class="muted">' + esc(meta) + '</span> ' + stt +
        (removable ? '<button class="editbtn att-remove" data-action="remove-media" data-id="' + esc(m.media_id) + '" title="삭제">✕</button>' : "") +
        '</div>' + preview + '</div>';
    }).join("") + '</div>';
  }

  /**
   * 지금 정밀 분석이 켜져 있는지 **첨부하는 자리에서** 알려 준다.
   *
   * 설정 화면까지 들어가야 알 수 있으면 아무도 확인하지 않는다.
   * 그러면 키를 안 넣은 채 사진을 올리고 "왜 분석이 안 되지" 하게 된다.
   * 꺼져 있어도 접수는 그대로 된다 — 규칙 엔진이 오프라인으로 돈다.
   */
  function visionStateHTML() {
    var on = settings.vision_provider !== "none" && settings.vision_key;
    var who = { openai: "OpenAI", claude: "Claude", solar: "Solar" }[settings.vision_provider]
              || settings.vision_provider;
    return '<div class="vision-state ' + (on ? "on" : "off") + '">' +
      '<span>' + (on
        ? '🔍 <b>정밀 분석 켜짐</b> — 첨부한 사진·영상을 ' + esc(who) + ' 가 함께 살펴봅니다.'
        : '📴 <b>오프라인 규칙 엔진</b>으로 접수합니다 — 사진은 증거로 첨부만 됩니다.' +
          ' API 키를 넣으면 사진 속 상태까지 읽습니다.') + '</span>' +
      '<button type="button" data-action="open-settings">' +
        (on ? "설정 보기" : "API 키 넣기") + '</button></div>';
  }

  /* ── C-01 입력 + 장비 선택 + 음성/미디어 첨부 (2차 고도화: 핸즈프리 우선) ── */
  function viewC01() {
    var sttReady = E.stt.supported(window);
    var sttHint = settings.stt_engine === "whisper"
      ? (settings.whisper_key ? "녹음 종료 후 Whisper 로 자동 전사됩니다." : "Whisper 키 미등록 — ⚙ 설정에서 등록하면 자동 전사됩니다.")
      : (sttReady ? "말하면 실시간으로 텍스트가 채워집니다." : "이 브라우저는 실시간 전사 미지원 — 녹음은 증거로 첨부됩니다.");
    return '' +
      '<section class="card" id="view-c01">' +
      '<h2>무슨 일이 있었나요? <span class="sr">(C-01)</span></h2>' +
      '<p class="muted">화면을 보기 어려운 현장에서는 <b>음성으로 접수</b>를 누르고 말씀하세요. 전문용어는 필요 없습니다.</p>' +
      '<button class="record-btn" id="btn-record" data-action="record-start">🎤 음성으로 접수 (녹음 시작)</button>' +
      '<p class="muted" style="margin-top:4px">' + esc(sttHint) + '</p>' +
      visionStateHTML() +
      /* 현장에서는 방금 찍은 사진을 창에 끌어다 놓는 것이 가장 빠르다.
         버튼도 함께 남긴다 — 휴대폰에서는 끌어다 놓기가 안 되고 카메라를 바로 여는 것이 낫다. */
      '<label class="drop-media" id="drop-media">' +
      '<input type="file" id="input-media" accept="image/*,video/*" multiple>' +
      '<b>사진·영상을 끌어다 놓거나 눌러서 고르세요</b>' +
      '<span>여러 장을 한 번에 넣을 수 있습니다 · 영상 최대 ' + E.media.formatBytes(E.media.LIMITS.video) + '</span>' +
      '</label>' +
      '<div class="attach-row">' +
      '<label class="attach-btn">📷 카메라로 찍기<input type="file" id="input-image" accept="image/*" capture="environment" hidden></label>' +
      '<label class="attach-btn">🎬 영상 고르기 <span class="sr">(최대 ' + E.media.formatBytes(E.media.LIMITS.video) + ')</span><input type="file" id="input-video" accept="video/*" hidden></label>' +
      '</div>' +
      attachmentListHTML(state.draftMedia, true) +
      '<label class="fld" for="input-text">현상 설명 (음성 전사 자동 삽입 · 직접 수정 가능)</label>' +
      '<textarea id="input-text" placeholder="예) 붐을 내리고 오른쪽으로 돌면 가끔 덜컹거립니다.">' + esc(state.c01Text || "") + '</textarea>' +
      '<label class="fld" for="select-equipment">장비 선택 (보유장비)</label>' +
      '<select id="select-equipment">' +
      EQUIPMENTS.map(function (e, i) {
        return '<option value="' + i + '">' + esc(eqLabel(e)) + '</option>';
      }).join("") +
      '</select>' +
      '<p class="muted" style="margin-top:6px">장비 식별(MNT-12)은 자동 획득 — 질문 예산을 쓰지 않습니다.</p>' +
      '<button class="primary" id="btn-analyze" data-action="analyze">다음 (내용 분석)</button>' +
      '<button class="back" data-action="go-c04">← 내 접수 목록</button>' +
      '</section>';
  }

  /* ── 안전 위험 분기 (FR-05) ── */
  function viewSafety() {
    var hits = (state.draft.intentResult.safety_hits || []).map(function (h) { return h.keyword; });
    return '' +
      '<section class="safety" id="view-safety">' +
      '<h2>🚨 안전 위험이 감지되었습니다</h2>' +
      '<p>입력 내용에서 위험 신호(<b>' + esc(hits.join(", ")) + '</b>)가 확인되어 <b>정보 수집을 중단</b>했습니다.</p>' +
      '<ul>' +
      '<li>즉시 장비를 정지하고 안전한 곳으로 대피하세요.</li>' +
      '<li>긴급 상황이면 <b>사내 안전상황실(내선 119)</b> 또는 119로 연락하세요.</li>' +
      '<li>아래 버튼으로 긴급 접수하면 추가 질문 없이 전문가에게 즉시 전달됩니다.</li>' +
      '</ul>' +
      '<div class="row-actions">' +
      '<button class="danger" id="btn-safety-submit" data-action="safety-submit">긴급 접수하기</button>' +
      '<button class="ghost" data-action="go-c01">돌아가기</button>' +
      '</div>' +
      '</section>';
  }

  /* ── C-02 선택지 질문 (진행 표시, [모르겠음], [건너뛰기]) ── */
  function viewC02() {
    var d = state.draft;
    var q = d.questions[d.qIndex];
    var freeInput = q.answer_type === "free_choice"
      ? '<div class="freeinput-row"><input type="text" id="free-answer" placeholder="직접 입력">' +
        '<button class="ghost" data-action="answer-free">확인</button></div>'
      : "";
    return '' +
      '<section class="card question-card" id="view-c02">' +
      '<div class="progress" id="q-progress">' + d.questions.length + '가지만 확인할게요 (' + (d.qIndex + 1) + '/' + d.questions.length + ')</div>' +
      '<div class="qtitle" id="q-text">' + esc(q.question_text) + '</div>' +
      '<p class="muted">' + esc(q.label) + ' · 판단영향도 ' + q.decision_impact.toFixed(1) + '</p>' +
      '<div class="opt-grid">' +
      q.options.map(function (o) {
        return '<button class="opt option-btn" data-action="answer" data-value="' + esc(o) + '">' + esc(o) + '</button>';
      }).join("") +
      '</div>' + freeInput +
      '<div class="row-actions">' +
      '<button class="ghost" id="btn-skip" data-action="skip">건너뛰기</button>' +
      '</div>' +
      '</section>';
  }

  /* ── C-03 선택적 확인 (저신뢰 상위 2개만 강조, DP-4) ── */
  function viewC03() {
    var d = state.draft;
    var targets = E.confidence.confirmTargets(d.collected, MNT);
    var targetIds = targets.map(function (t) { return t.requirement_id; });
    var rows = E.gap.scenarioRequirements(MNT, d.scenario).map(function (req) {
      var c = collectedOf(d, req.requirement_id);
      if (targetIds.indexOf(req.requirement_id) >= 0) return ""; // 강조 박스에서 별도 표시
      var val;
      if (c && c.value_state === "known") val = esc(c.value);
      else if (c && c.value_state === "unknown") val = '<span class="value-missing">모르겠음(unknown)</span>';
      else if (c && c.value_state === "skipped") val = '<span class="value-missing">건너뜀</span>';
      else if (req.ask_policy === "expert_check") val = '<span class="value-missing">정보 부족 → 전문가 확인 항목</span>';
      else val = '<span class="value-missing">미확보</span>';
      var editable = req.ask_policy === "ask";
      return '<tr><td class="k">' + esc(req.label) + '</td><td>' + val + '</td>' +
        '<td class="a">' + (editable ? '<button class="editbtn" data-action="edit-field" data-req="' + req.requirement_id + '" title="수정">✎</button>' : "") + '</td></tr>';
    }).join("");

    var boxes = targets.map(function (t) {
      var req = reqOf(t.requirement_id);
      var opts = (req.options || []).map(function (o) {
        return '<button class="opt" data-action="confirm-fix" data-req="' + req.requirement_id + '" data-value="' + esc(o) + '">' + esc(o) + '</button>';
      }).join("");
      return '<div class="warnbox lowconf-box" data-req="' + req.requirement_id + '">' +
        '<div class="t">⚠ 이 항목만 확인해 주세요 — ' + esc(req.label) + '</div>' +
        '<p>"<b>' + esc(t.value) + '</b>" 으로 이해했습니다. (신뢰도 ' + t.confidence + ')</p>' +
        '<div class="opt-grid">' +
        '<button class="opt btn-confirm-ok" data-action="confirm-ok" data-req="' + req.requirement_id + '">맞아요</button>' +
        opts +
        '</div></div>';
    }).join("");

    var editForm = "";
    if (state.editReq) {
      var er = reqOf(state.editReq);
      editForm = '<div class="warnbox"><div class="t">✎ ' + esc(er.label) + ' 수정</div><div class="opt-grid">' +
        (er.options || []).concat([E.question.UNKNOWN_OPTION]).filter(function (v, i, a) { return a.indexOf(v) === i; })
          .map(function (o) {
            return '<button class="opt" data-action="confirm-fix" data-req="' + er.requirement_id + '" data-value="' + esc(o) + '">' + esc(o) + '</button>';
          }).join("") +
        '</div></div>';
    }

    return '' +
      '<section class="card" id="view-c03">' +
      '<h2>이렇게 이해했습니다 <span class="sr">(C-03)</span></h2>' +
      '<p class="muted">' + esc(eqLabel(d.equipment)) + ' · ' + esc(d.scenario.label) + '</p>' +
      '<table class="fields">' + rows + '</table>' +
      boxes + editForm +
      (state.draftMedia.length
        ? '<h3>첨부 (' + state.draftMedia.length + '건)</h3>' + attachmentListHTML(state.draftMedia, false)
        : "") +
      (d.mediaFindings
        ? '<p class="notice">🖼 미디어 분석: ' + esc(d.mediaFindings.summary || "") + '</p>'
        : "") +
      '<div class="origin">고객 원문 “' + esc(d.text) + '”</div>' +
      '<button class="primary" id="btn-submit-issue" data-action="submit-issue">접수하기</button>' +
      '</section>';
  }

  /* ── C-04 내 접수 목록 ── */
  function viewC04() {
    var mine = db.issues.slice().reverse();
    var items = mine.length ? mine.map(function (i) {
      return '<div class="issue-item" data-action="open-cdetail" data-no="' + i.issue_id + '">' +
        '<span class="no">#' + i.issue_id + '</span>' +
        '<span class="grow"><span class="t">' + esc(i.title) + '</span><br><span class="muted">' + esc(eqLabel(i.equipment_ref)) + ' · ' + fmt(i.created_at) + '</span></span>' +
        '<span class="badge status-badge b-' + i.status + '">' + esc(E.statemachine.LABELS[i.status] || i.status) + '</span>' +
        '</div>';
    }).join("") : '<p class="muted" style="padding:12px 0">접수한 이슈가 없습니다. 새 이슈를 접수해 보세요.</p>';
    return '' +
      '<section class="card" id="view-c04">' +
      '<h2>내 접수 목록 <span class="sr">(C-04)</span></h2>' +
      '<div id="issue-list">' + items + '</div>' +
      '<button class="primary" id="btn-new-issue" data-action="go-c01">+ 새 이슈 접수</button>' +
      '</section>';
  }

  /* ── C-04 상세 + C-05 답변 확인/해결 응답 ── */
  function viewCDetail() {
    var issue = getIssue(state.current);
    if (!issue) { state.view = "c04"; return viewC04(); }
    var html = '<button class="back" data-action="go-c04">← 목록</button>';

    html += '<section class="card">' +
      '<h2>#' + issue.issue_id + ' ' + esc(issue.title) + ' ' +
      '<span class="badge status-badge b-' + issue.status + '" id="cdetail-status">' + esc(E.statemachine.LABELS[issue.status]) + '</span></h2>' +
      '<p class="muted">' + esc(eqLabel(issue.equipment_ref)) + ' · ' + fmt(issue.created_at) + '</p>' +
      '<div class="origin">내가 말한 내용 “' + esc(issue.user_input.original_text) + '”</div>' +
      '</section>';

    // 진행 알림 (FR-22)
    html += '<section class="card"><h3>진행 알림</h3><ul class="timeline">' +
      issue.notifications.map(function (n) {
        return '<li><span class="ts">' + fmt(n.ts) + '</span>' + esc(n.text) + '</li>';
      }).join("") + '</ul></section>';

    // PENDING_FIELD: 현장 확인 요청 회신 (회신 루프)
    if (issue.status === "PENDING_FIELD" && issue.pending_request) {
      html += '<section class="card"><h3>📋 현장에서 확인이 필요한 항목</h3>' +
        '<ul style="margin-left:18px">' + issue.pending_request.items.map(function (it) { return '<li>' + esc(it) + '</li>'; }).join("") + '</ul>' +
        '<label class="fld" for="pending-reply">확인 결과</label>' +
        '<textarea id="pending-reply" placeholder="예) 예열 10분 후에는 증상이 없었습니다."></textarea>' +
        '<button class="primary" id="btn-send-reply" data-action="send-pending-reply">확인 내용 보내기</button>' +
        '</section>';
    }

    // C-05 답변 확인 + 해결 여부 응답
    if (issue.customer_response && ["ANSWERED", "RESOLVED", "REOPENED", "KNOWLEDGE_READY"].indexOf(issue.status) >= 0) {
      html += '<section class="card" id="answer-view"><h3>전문가 답변 <span class="sr">(C-05)</span></h3>' +
        '<div class="origin" id="customer-answer">' + esc(issue.customer_response.simplified_response) + '</div>' +
        '<p class="muted" style="margin-top:6px">발송 ' + fmt(issue.customer_response.delivered_at) + ' · 승인 ' + esc(issue.customer_response.approved_by) + '</p>';
      if (issue.status === "ANSWERED") {
        html += '<p style="margin-top:12px"><b>문제가 해결되었나요?</b></p>' +
          '<div class="row-actions">' +
          '<button class="okbtn" id="btn-resolved" data-action="feedback-resolved">해결됨</button>' +
          '<button class="danger" id="btn-unresolved" data-action="feedback-unresolved">해결 안 됨</button>' +
          '<button class="ghost" id="btn-requestion" data-action="feedback-requestion">다시 질문</button>' +
          '</div>';
      } else if (issue.status === "RESOLVED" || issue.status === "KNOWLEDGE_READY") {
        html += '<p class="notice" id="resolved-note">✅ 해결 확인 감사합니다.' +
          (issue.status === "KNOWLEDGE_READY" ? " 이 사례는 검증된 지식(Knowledge) 승격 후보로 등록되었습니다." : "") + '</p>';
      } else if (issue.status === "REOPENED") {
        html += '<p class="notice">전문가가 다시 검토 중입니다 (REOPENED · 재검토 ' + issue.reopen_count + '회).</p>';
      }
      html += '</section>';
    }
    return html;
  }

  /* ── E-01 My Queue (진행중 / 정보대기 레인 분리) ── */
  function viewE01() {
    var active = [], waiting = [], done = [];
    db.issues.forEach(function (i) {
      if (["SUBMITTED", "ASSIGNED", "IN_REVIEW", "REOPENED"].indexOf(i.status) >= 0) active.push(i);
      else if (i.status === "PENDING_FIELD") waiting.push(i);
      else done.push(i);
    });
    function card(i) {
      var checks = (i.expert_checks || []).map(function (c) { return c.label; });
      return '<div class="queue-card" data-no="' + i.issue_id + '">' +
        '<div class="head"><span class="no">● #' + i.issue_id + '</span> <span>' + esc(i.title) + '</span>' +
        '<span class="suff">정보충분도 ' + sufficiencyOf(i) + '%</span></div>' +
        '<div class="meta">' + esc(eqLabel(i.equipment_ref)) +
        (checks.length ? ' · ⚠ ' + esc(checks.join("·")) + ' 미확보' : "") +
        ' · ⏱ ' + elapsed(i.created_at) +
        ' · <span class="badge b-' + i.status + '">' + esc(E.statemachine.LABELS[i.status]) + '</span></div>' +
        '<button class="ghost btn-open" data-action="open-edetail" data-no="' + i.issue_id + '">열기</button>' +
        '</div>';
    }
    return '' +
      '<section class="card" id="view-e01">' +
      '<h2>내 작업 <span class="sr">(E-01 My Queue)</span></h2>' +
      '<p class="muted">진행중 ' + active.length + ' · 정보대기 ' + waiting.length + ' · 완료 ' + done.length + '</p>' +
      '<div class="lane-title">진행중 (' + active.length + ')</div>' +
      '<div id="queue-active">' + (active.map(card).join("") || '<p class="muted">진행중 이슈가 없습니다.</p>') + '</div>' +
      '<div class="lane-title">▸ 정보 대기 (' + waiting.length + ') — 고객 응답 대기 중</div>' +
      '<div id="queue-waiting">' + (waiting.map(card).join("") || '<p class="muted">정보 대기 이슈가 없습니다.</p>') + '</div>' +
      '<div class="lane-title">완료·종결 (' + done.length + ')</div>' +
      '<div id="queue-done">' + (done.map(card).join("") || '<p class="muted">완료된 이슈가 없습니다.</p>') + '</div>' +
      '</section>';
  }

  /** E-02: 첨부 미디어(원본 증거) — 오디오는 전사 세그먼트 칩(클릭 시 해당 지점 재생) */
  function expertAttachmentsHTML(issue) {
    var atts = issue.attachments || [];
    if (!atts.length) return "";
    var html = '<h3>첨부 원본 <span class="sr">(IndexedDB 불변 보존 · FR-27 정책 대상)</span></h3><div class="att-list" id="issue-attachments">';
    atts.forEach(function (m, ai) {
      var icon = m.kind === "audio" ? "🔊" : m.kind === "image" ? "🖼" : "🎬";
      var meta = E.media.formatBytes(m.size) +
        (m.duration_ms ? " · " + E.media.formatDuration(m.duration_ms / 1000) : "");
      html += '<div class="att-item"><div class="att-head">' + icon + ' <b>' + esc(m.name) + '</b> <span class="muted">' + esc(meta) + '</span></div>';
      if (m.kind === "image") {
        html += '<img class="att-thumb" data-media-src="' + esc(m.media_id) + '" data-action="zoom-img" alt="' + esc(m.name) + '" title="클릭하면 확대">';
      } else if (m.kind === "video") {
        html += '<video controls preload="metadata" class="att-video" data-media-src="' + esc(m.media_id) + '"></video>';
      } else {
        html += '<audio controls preload="metadata" data-media-src="' + esc(m.media_id) + '"></audio>';
        if (m.transcript && m.transcript.length) {
          html += '<div class="seg-list">' + m.transcript.map(function (s, si) {
            var active = state.activeSeg && state.activeSeg.media_id === m.media_id && state.activeSeg.index === si;
            return '<button class="seg-chip' + (active ? " seg-active" : "") + '" data-action="play-seg" ' +
              'data-media="' + esc(m.media_id) + '" data-ms="' + s.start_ms + '" data-index="' + si + '">' +
              '▶ ' + E.media.formatDuration(s.start_ms / 1000) + ' “' + esc(s.text) + '”</button>';
          }).join("") + '</div>';
        }
      }
      html += '</div>';
    });
    return html + '</div>';
  }

  /* ── E-02~E-05 이슈 상세 (근거 점프 · AI 분석 · 구조화 결론 · 승인) ── */
  function viewEDetail() {
    var issue = getIssue(state.current);
    if (!issue) { state.view = "e01"; return viewE01(); }
    var scenario = scenarioOf(issue);
    var g = E.gap.analyze(MNT, scenario, issue.collected);

    var html = '<button class="back" data-action="go-e01">← My Queue</button>';

    /* E-02: 정형화 결과 + 원본 근거 점프 */
    var rows = g.rows.filter(function (r) { return r.requirement_id !== "MNT-12"; }).map(function (r) {
      var c = r.item;
      var val, evi = "—";
      if (c && c.value_state === "known") {
        val = esc(c.value);
        var ref = c.evidence_ref || {};
        if (ref.input_id) {
          evi = '<button class="evi evidence-link" data-action="jump" data-input="' + esc(ref.input_id) + '" data-start="' + ref.start + '" data-end="' + ref.end + '">📄 원문 ' + ref.start + '–' + ref.end + '</button>';
        } else if (ref.type === "answer") {
          evi = '<span class="evi">💬 ' + esc((ref.question_id || "").split("-")[0] || "질문") + ' 응답</span>';
        } else if (ref.type === "system") {
          evi = '<span class="evi">⚙ 시스템 획득</span>';
        } else if (ref.type === "media") {
          evi = '<span class="evi">🖼 미디어 분석</span>';
        }
        if (c.source_type === "answered" && c.confirmed) val += ' <span class="sr">(고객 확인됨)</span>';
      } else if (c && c.value_state === "unknown") {
        val = '<span class="value-missing">모르겠음(unknown)</span>';
      } else if (c && c.value_state === "skipped") {
        val = '<span class="value-missing">건너뜀(skipped)</span>';
      } else {
        val = '<span class="value-missing">' + (r.ask_policy === "expert_check" ? "미확보 (계측 필요)" : "미확보") + '</span>';
      }
      return '<tr><td class="k">' + esc(r.label) + '</td><td>' + val + '</td><td style="text-align:right">' + evi + '</td></tr>';
    }).join("");

    var originalHtml = esc(issue.user_input.original_text);
    if (state.hl && state.hl.input_id === issue.user_input.input_id) {
      var t = issue.user_input.original_text;
      originalHtml = esc(t.slice(0, state.hl.start)) +
        '<mark class="hl">' + esc(t.slice(state.hl.start, state.hl.end)) + '</mark>' +
        esc(t.slice(state.hl.end));
    }

    html += '<section class="card" id="issue-detail">' +
      '<h2>ISSUE #' + issue.issue_id + ' <span class="badge b-' + issue.status + '" id="edetail-status">' + esc(E.statemachine.LABELS[issue.status]) + '</span></h2>' +
      '<p class="muted">정비 · ' + esc(issue.safety_level) + ' · ' + esc(eqLabel(issue.equipment_ref)) + ' · ' + fmt(issue.created_at) + ' · 정보충분도 ' + Math.round(g.sufficiency * 100) + '%</p>' +
      '<h3>정형화 결과 <span class="sr">(E-02 · 근거 클릭 시 원문 하이라이트)</span></h3>' +
      '<table class="fields">' + rows + '</table>' +
      ((issue.expert_checks || []).length ?
        '<p class="notice" style="margin-top:10px">🔧 전문가 추가 확인 항목: ' +
        esc(issue.expert_checks.map(function (c) { return c.label; }).join(", ")) +
        ' <span class="sr">(획득가능성 ‘하’ — 고객에게 묻지 않음)</span></p>' : "") +
      '<h3>고객 원문</h3>' +
      '<div class="origin" id="original-text">“' + originalHtml + '”</div>' +
      expertAttachmentsHTML(issue) +
      (issue.pending_request && issue.pending_request.reply ?
        '<h3>현장 확인 회신</h3><div class="origin">“' + esc(issue.pending_request.reply) + '”</div>' : "") +
      '</section>';

    /* E-03: Mock AI 분석 (+선택 정밀 모드 미디어 분석 결과) */
    html += '<section class="card" id="ai-section"><h3>AI 1차 분석 <span class="sr">(E-03 · Mock Rule Engine)</span></h3>';
    if (issue.media_findings) {
      var mf = issue.media_findings;
      html += '<div class="simcase" id="media-findings"><b>🖼 미디어 분석</b> <span class="muted">(정밀 모드 · 이미지 ' + (mf.image_count || 0) + '장)</span>' +
        '<br>현상 요약: ' + esc(mf.summary || "—") +
        '<br>보이는 장비/부품: ' + esc((mf.observed || []).join(", ") || "—") +
        ((mf.hazards || []).length ? '<br><span style="color:var(--danger)">⚠ 위험 신호: ' + esc(mf.hazards.join(", ")) + '</span>' : "") +
        '</div>';
    }
    if (!issue.ai_analysis) {
      html += '<p class="muted">표준·매뉴얼·과거사례(Mock 저장소)를 근거로 A/B/C/D 판정을 제시합니다.</p>' +
        '<button class="primary" id="btn-run-ai" data-action="run-ai">AI 분석 실행</button>';
    } else {
      var a = issue.ai_analysis;
      html += '<div id="ai-result">' +
        '<span class="verdict v' + a.verdict + '">판정 ' + a.verdict + ' — ' + esc(a.verdict_label) + '</span>' +
        '<p>' + esc(a.recommendation) + '</p>' +
        (a.similar_cases || []).map(function (c) {
          return '<div class="simcase">🔗 <b>' + esc(c.case_id) + '</b> (' + Math.round(c.similarity * 100) + '%) ' + esc(c.title) +
            '<br><span class="muted">' + esc(c.resolution) + '</span></div>';
        }).join("") +
        (a.related_documents || []).map(function (dcm) {
          return '<div class="simcase">📘 <b>' + esc(dcm.doc_id) + '</b> ' + esc(dcm.title) + '</div>';
        }).join("") +
        ((a.evidence || []).length ? '<p class="muted">근거: ' + esc(a.evidence.join(" / ")) + '</p>' : "") +
        '<div class="limbox">⚠ ' + esc(a.limitations) + '</div>';
      if (a.verdict === "D" && issue.status === "IN_REVIEW") {
        html += '<p class="muted" style="margin-top:8px">추가 필요 정보: ' + esc((a.missing_info || []).join(", ")) + '</p>' +
          '<button class="primary" id="btn-request-field" data-action="request-field">고객에게 추가 확인 요청</button>';
      }
      html += '</div>';
    }
    html += '</section>';

    /* E-04: 구조화 결론 (자유 서술 → AI 초안 → 4필드) */
    var opinionDone = !!issue.expert_opinion;
    var canConclude = issue.status === "IN_REVIEW";
    if (opinionDone) {
      var op = issue.expert_opinion;
      html += '<section class="card" id="opinion-section"><h3>구조화 결론 (확정) <span class="sr">(E-04)</span></h3>' +
        '<table class="fields">' +
        '<tr><td class="k">확정 원인</td><td id="final-cause">' +
        (op.cause_undetermined
          ? '원인 미확정 · 사유: ' + esc(op.cause_undetermined_reason_label || op.cause_undetermined_reason)
          : esc(op.cause_system_label) + ' / ' + esc(op.cause_part_label) + ' <span class="code-chip">' + esc(op.cause_part_code) + '</span>') +
        '</td></tr>' +
        '<tr><td class="k">조치 내용</td><td>' + esc(op.action_detail) + ' <span class="badge">' + esc(op.action_type) + '</span></td></tr>' +
        '<tr><td class="k">판단 근거</td><td>' + esc((op.rationale_refs || []).join(" · ")) + (op.rationale_text ? '<br><span class="muted">' + esc(op.rationale_text) + '</span>' : "") + '</td></tr>' +
        '<tr><td class="k">재발 방지</td><td>' + esc(op.prevention || "—") + '</td></tr>' +
        '</table><p class="muted">확정 ' + fmt(op.finalized_at) + '</p></section>';
    } else if (canConclude) {
      html += viewE04Form(issue);
    } else {
      html += '<section class="card section-disabled"><h3>구조화 결론 <span class="sr">(E-04)</span></h3>' +
        '<p class="muted">검토 중(IN_REVIEW) 상태에서 입력할 수 있습니다.</p></section>';
    }

    /* E-05: 고객 답변 승인 */
    if (issue.customer_response) {
      html += '<section class="card"><h3>고객 회신 (발송 완료) <span class="sr">(E-05)</span></h3>' +
        '<div class="compare">' +
        '<div class="pane"><h4>전문가 원본</h4>' + esc(issue.customer_response.technical_original) + '</div>' +
        '<div class="pane"><h4>고객용 재작성 (발송본)</h4>' + esc(issue.customer_response.simplified_response) + '</div>' +
        '</div><p class="muted">승인 ' + esc(issue.customer_response.approved_by) + ' · ' + fmt(issue.customer_response.approved_at) + '</p></section>';
    } else if (opinionDone && issue.status === "IN_REVIEW") {
      var tech = issue.expert_opinion.original_text || issue.expert_opinion.rationale_text || "";
      if (state.rewriteText == null) state.rewriteText = adapter.rewriteForCustomer(tech);
      html += '<section class="card" id="approval-view"><h3>고객 답변 승인 <span class="sr">(E-05 · 발송 전 1-click 승인 게이트)</span></h3>' +
        '<div class="compare">' +
        '<div class="pane"><h4>전문가 원본 (불변 저장)</h4><span id="tech-original">' + esc(tech) + '</span></div>' +
        '<div class="pane"><h4>AI 고객용 재작성 (치환 템플릿)</h4>' +
        '<textarea id="customer-rewrite">' + esc(state.rewriteText) + '</textarea>' +
        '<p class="muted">[수정]: 위 텍스트를 직접 편집하세요. 전문가 원본은 덮어쓰지 않습니다.</p></div>' +
        '</div>' +
        '<button class="primary" id="btn-approve-send" data-action="approve-send">승인 후 발송</button>' +
        '</section>';
    }

    /* 감사 이력 (FR-25) */
    html += '<section class="card"><h3>감사 이력 <span class="sr">(FR-25 · append-only)</span></h3><div class="audit" id="audit-trail">' +
      issue.audit.map(function (a) {
        var d = a.detail ? (a.detail.from ? a.detail.from + " → " + a.detail.to + (a.detail.note ? " (" + a.detail.note + ")" : "") : JSON.stringify(a.detail)) : "";
        return '<div>#' + a.seq + ' · ' + fmt(a.ts) + ' · ' + esc(a.actor) + ' · ' + esc(a.event) + ' ' + esc(d) + '</div>';
      }).join("") +
      '</div></section>';

    return html;
  }

  /** E-04 입력 폼 */
  function viewE04Form(issue) {
    var f = state.opinionForm || (state.opinionForm = {
      free_text: "", part_code: null, undetermined: false, reason: "",
      action_type: "", action_detail: "", refs: {}, rationale_text: "", prevention: ""
    });
    var selectedPart = f.part_code ? S.parts.parts.filter(function (p) { return p.part_code === f.part_code; })[0] : null;
    var selectedSystem = selectedPart ? S.parts.systems.filter(function (s) { return s.system_code === selectedPart.system_code; })[0] : null;

    var q = (state.partQuery || "").trim();
    var results = "";
    if (q) {
      var found = S.parts.parts.filter(function (p) {
        var sys = S.parts.systems.filter(function (s) { return s.system_code === p.system_code; })[0];
        var hay = p.part_code + " " + p.label + " " + (sys ? sys.label + " " + sys.group : "");
        return hay.toLowerCase().indexOf(q.toLowerCase()) >= 0;
      }).slice(0, 8);
      results = '<div class="part-results">' +
        (found.length ? found.map(function (p) {
          var sys = S.parts.systems.filter(function (s) { return s.system_code === p.system_code; })[0];
          return '<button class="part-result" data-action="pick-part" data-code="' + esc(p.part_code) + '">' +
            '<b>' + esc(p.part_code) + '</b> ' + esc(p.label) + ' <span class="muted">(' + esc(sys ? sys.label : "") + ')</span></button>';
        }).join("") : '<p class="muted" style="padding:10px">검색 결과 없음 — 코드가 없으면 ‘원인 미확정’으로 종결하세요.</p>') +
        '</div>';
    }

    var aiRefs = [];
    if (issue.ai_analysis) {
      (issue.ai_analysis.similar_cases || []).forEach(function (c) { aiRefs.push(c.case_id); });
      (issue.ai_analysis.related_documents || []).forEach(function (d) { aiRefs.push(d.doc_id); });
    }
    aiRefs.push("전문가 경험");
    var refChecks = aiRefs.map(function (r) {
      return '<label class="check-row"><input type="checkbox" class="rationale-check" data-ref="' + esc(r) + '"' + (f.refs[r] ? " checked" : "") + '> ' + esc(r) + '</label>';
    }).join("");

    var reasons = S.undetermined.reasons.map(function (r) {
      return '<option value="' + esc(r.code) + '"' + (f.reason === r.code ? " selected" : "") + '>' + esc(r.label) + '</option>';
    }).join("");

    return '' +
      '<section class="card" id="opinion-section"><h3>구조화 결론 입력 <span class="sr">(E-04 · 자유 서술 → AI 4필드 초안 → 확정)</span></h3>' +
      '<label class="fld" for="expert-free-text">자유 서술 (음성 대신 텍스트, DP-6)</label>' +
      '<textarea id="expert-free-text" placeholder="예) 유압 오일 온도가 낮은 상태에서 선회 압력이 순간적으로 상승해서 발생하는 현상으로 판단됩니다. 예열 후 재현 확인하고 미재현 시 정상 판정하면 됩니다. 동절기 예열 절차 안내가 필요합니다.">' + esc(f.free_text) + '</textarea>' +
      '<button class="ghost" id="btn-ai-draft" data-action="ai-draft" style="margin-top:10px;width:100%">AI 초안 생성</button>' +

      '<h3>① 확정 원인 <span class="sr">*필수 · 계통/부품 코드 마스터 선택(자유 텍스트 금지)</span></h3>' +
      '<input type="text" id="part-search" placeholder="🔍 부품/계통 검색 (예: 선회, 릴리프, SW-HYD)" value="' + esc(state.partQuery) + '">' +
      results +
      (selectedPart
        ? '<div><span class="code-chip" id="selected-part-code">' + esc(selectedPart.part_code) + '</span> ' +
          '<span id="selected-part-label">' + esc(selectedSystem.label) + ' / ' + esc(selectedPart.label) + '</span></div>'
        : '<p class="muted" style="margin-top:6px">선택된 코드 없음</p>') +
      '<label class="check-row" style="margin-top:8px"><input type="checkbox" id="chk-undetermined"' + (f.undetermined ? " checked" : "") + '> 원인 미확정으로 종결</label>' +
      '<select id="undetermined-reason"' + (f.undetermined ? "" : " disabled") + '><option value="">사유 선택 *필수</option>' + reasons + '</select>' +

      '<h3>② 조치 내용 <span class="sr">*필수</span></h3>' +
      '<select id="action-type"><option value="">조치 유형 선택</option>' +
      ["점검", "조정", "부품교체", "안내"].map(function (t) {
        return '<option value="' + t + '"' + (f.action_type === t ? " selected" : "") + '>' + t + '</option>';
      }).join("") + '</select>' +
      '<input type="text" id="action-detail" placeholder="조치 내용" value="' + esc(f.action_detail) + '" style="margin-top:8px">' +

      '<h3>③ 판단 근거 <span class="sr">*필수(1개 이상 체크)</span></h3>' +
      refChecks +
      '<input type="text" id="rationale-text" placeholder="보충 서술 (예: 냉간 시 선회 압력 순간 상승으로 판단)" value="' + esc(f.rationale_text) + '">' +

      '<h3>④ 재발 방지 <span class="sr">선택</span></h3>' +
      '<input type="text" id="prevention" placeholder="예: 동절기 예열 절차 안내" value="' + esc(f.prevention) + '">' +

      '<button class="primary" id="btn-finalize" data-action="finalize-opinion">결론 확정</button>' +
      '</section>';
  }

  /* ────────────────────────── 액션 처리 ────────────────────────── */

  function syncOpinionForm() {
    var f = state.opinionForm;
    if (!f) return;
    var g = function (id) { var el = document.getElementById(id); return el ? el.value : null; };
    if (g("expert-free-text") != null) f.free_text = g("expert-free-text");
    if (g("action-type") != null) f.action_type = g("action-type");
    if (g("action-detail") != null) f.action_detail = g("action-detail");
    if (g("rationale-text") != null) f.rationale_text = g("rationale-text");
    if (g("prevention") != null) f.prevention = g("prevention");
    if (g("undetermined-reason") != null) f.reason = g("undetermined-reason");
    var chk = document.getElementById("chk-undetermined");
    if (chk) f.undetermined = chk.checked;
    f.refs = {};
    Array.prototype.forEach.call(document.querySelectorAll(".rationale-check"), function (c) {
      if (c.checked) f.refs[c.getAttribute("data-ref")] = true;
    });
    var ps = document.getElementById("part-search");
    if (ps) state.partQuery = ps.value;
  }

  function openExpertIssue(no) {
    var issue = getIssue(no);
    if (!issue) return;
    // 큐에서 열기: SUBMITTED→ASSIGNED→IN_REVIEW, REOPENED→IN_REVIEW (상태머신 준수)
    if (issue.status === "SUBMITTED") E.statemachine.transition(issue, "ASSIGNED", { actor: "system", note: "전문가 열람 시 자동 배정" });
    if (issue.status === "ASSIGNED") E.statemachine.transition(issue, "IN_REVIEW", { actor: "전문가", note: "검토 시작" });
    if (issue.status === "REOPENED") E.statemachine.transition(issue, "IN_REVIEW", { actor: "전문가", note: "재검토 시작" });
    Store.save(db);
    state.current = no;
    state.view = "edetail";
    state.hl = null;
    state.opinionForm = null;
    state.partQuery = "";
    state.rewriteText = null;
  }

  function handleAction(action, el) {
    var issue = state.current != null ? getIssue(state.current) : null;

    switch (action) {
      /* 내비게이션 */
      case "go-c01": state.view = "c01"; state.draft = null; break;
      case "go-c04": state.view = "c04"; state.editReq = null; break;
      case "go-e01": state.view = "e01"; state.hl = null; break;
      case "open-cdetail": state.current = parseInt(el.getAttribute("data-no"), 10); state.view = "cdetail"; break;
      case "open-edetail": openExpertIssue(parseInt(el.getAttribute("data-no"), 10)); break;

      /* C-01 → 분석 (선택 정밀 모드: 첨부 이미지/영상 프레임 비전 분석 후 질문 산출) */
      case "analyze": {
        var text = document.getElementById("input-text").value.trim();
        if (!text) { alert("현상을 입력하거나 음성으로 말씀해 주세요."); return; }
        if (text.length > MAX_FREE_TEXT) {
          alert("현상 설명이 너무 깁니다(" + text.length + "자). " + MAX_FREE_TEXT + "자 이내로 핵심만 적어 주세요.");
          return;
        }
        state.c01Text = text;
        var eq = EQUIPMENTS[parseInt(document.getElementById("select-equipment").value, 10)];
        var hasVisual = state.draftMedia.some(function (m) { return m.kind === "image" || m.kind === "video"; });
        if (visionAdapter() && hasVisual) {
          state.busy = "첨부 미디어 정밀 분석 중… (실패해도 접수는 계속됩니다)";
          render();
          analyzeDraftMedia(text).then(function (findings) {
            state.busy = null;
            startAnalysis(text, eq, findings);
            render();
          });
          return; // 비동기 경로 — render 는 완료 시점에
        }
        startAnalysis(text, eq, null);
        break;
      }

      /* 음성 녹음 (2차 고도화) */
      case "record-start": startRecording(); return; // 자체 비동기 render
      case "record-stop": stopRecording(); return;   // onstop → finishRecording → render
      case "remove-media": removeDraftMedia(el.getAttribute("data-id")); break;
      case "dismiss-notice": state.notice = null; break;

      /* 설정 */
      case "open-settings": state.settingsOpen = true; break;
      case "close-settings": state.settingsOpen = false; break;
      case "save-settings": {
        settings.stt_engine = document.getElementById("set-stt").value;
        settings.whisper_key = document.getElementById("set-whisper-key").value.trim();
        settings.vision_provider = document.getElementById("set-vision").value;
        settings.vision_key = document.getElementById("set-vision-key").value.trim();
        settings.vision_model = document.getElementById("set-vision-model").value.trim();
        Settings.save(settings);
        state.settingsOpen = false;
        state.notice = "설정이 저장되었습니다. (키는 이 브라우저에만 보관)";
        break;
      }

      /* 음성 세그먼트 재생 (E-02 근거 점프 보조) */
      case "play-seg": {
        var segMediaId = el.getAttribute("data-media");
        var segMs = parseInt(el.getAttribute("data-ms"), 10) || 0;
        state.activeSeg = { media_id: segMediaId, index: parseInt(el.getAttribute("data-index"), 10) };
        syncOpinionForm();
        render();
        playAudioSegment(segMediaId, segMs);
        return;
      }
      case "zoom-img": el.classList.toggle("zoomed"); return;
      case "safety-submit": {
        // 안전 분기: 질문 없이 긴급 접수 (FR-05)
        var d = state.draft;
        d.scenario = E.gap.pickScenario(d.text, MNT);
        d.collected = E.gap.extract(d.text, MNT, d.scenario, d.input_id);
        d.questions = [];
        submitIssue({ safety: true });
        break;
      }

      /* C-02 */
      case "answer": answerQuestion(state.draft.questions[state.draft.qIndex], el.getAttribute("data-value"), false); break;
      case "answer-free": {
        var v = document.getElementById("free-answer").value.trim();
        if (!v) return;
        answerQuestion(state.draft.questions[state.draft.qIndex], v, false);
        break;
      }
      case "skip": answerQuestion(state.draft.questions[state.draft.qIndex], null, true); break;

      /* C-03 */
      case "confirm-ok": {
        var c1 = collectedOf(state.draft, el.getAttribute("data-req"));
        if (c1) {
          c1.source_type = "answered"; // 고객이 직접 확인 → 출처 상승
          c1.confidence = E.confidence.confidenceFor("answered");
          c1.confirmed = true;
          c1.coverage = "full";
        }
        break;
      }
      case "confirm-fix": {
        var reqId = el.getAttribute("data-req");
        var val = el.getAttribute("data-value");
        var req2 = reqOf(reqId);
        if (val === E.question.UNKNOWN_OPTION) {
          upsertCollected(state.draft, {
            requirement_id: reqId, label: req2.label, value: null, value_state: "unknown",
            coverage: "full", source_type: "answered", confidence: null,
            evidence_ref: { input_id: null, type: "answer", question_id: "confirm" }
          });
        } else {
          upsertCollected(state.draft, {
            requirement_id: reqId, label: req2.label, value: val, value_state: "known",
            coverage: "full", source_type: "answered",
            confidence: E.confidence.confidenceFor("answered"), confirmed: true,
            evidence_ref: { input_id: null, type: "answer", question_id: "confirm" }
          });
        }
        state.editReq = null;
        break;
      }
      case "edit-field": state.editReq = el.getAttribute("data-req"); break;
      case "submit-issue": state.editReq = null; submitIssue(); break;

      /* C-04/05 회신 루프 */
      case "send-pending-reply": {
        var reply = document.getElementById("pending-reply").value.trim();
        if (!reply) { alert("확인 결과를 입력해 주세요."); return; }
        issue.pending_request.reply = reply;
        issue.pending_request.replied_at = now();
        E.statemachine.appendAudit(issue, "field_reply", { reply: reply }, "접수자");
        E.statemachine.transition(issue, "IN_REVIEW", { actor: "system", note: "고객 확인 회신 수신" });
        notify(issue, "확인 내용이 전문가에게 전달되었습니다");
        Store.save(db);
        break;
      }
      case "feedback-resolved": {
        issue.feedback.push({ result: "resolved", comment: null, responded_at: now() });
        E.statemachine.transition(issue, "RESOLVED", { actor: "접수자", note: "고객 해결 확인" });
        // Knowledge 승격 게이트: RESOLVED + 원인 확정 + 승인 사례만 (DP-8)
        var op1 = issue.expert_opinion;
        if (op1 && !op1.cause_undetermined && issue.customer_response && issue.customer_response.approved_at) {
          E.statemachine.transition(issue, "KNOWLEDGE_READY", { actor: "system", note: "Knowledge 승격 후보 등록(검증된 사례)" });
          issue.knowledge_entry = {
            source_issue_id: issue.issue_id, verified: true,
            curated_by: null, reuse_count: 0, created_at: now()
          };
          db.knowledge.push(issue.knowledge_entry);
        }
        notify(issue, "해결 확인 완료 — 감사합니다");
        Store.save(db);
        break;
      }
      case "feedback-unresolved": {
        issue.feedback.push({ result: "unresolved", comment: null, responded_at: now() });
        issue.reopen_count++;
        E.statemachine.transition(issue, "REOPENED", { actor: "접수자", note: "해결 안 됨 → 재검토" });
        notify(issue, "재검토를 요청했습니다. 전문가가 다시 확인합니다");
        Store.save(db);
        break;
      }
      case "feedback-requestion": {
        var cm = window.prompt("추가로 궁금한 내용을 입력해 주세요.", "");
        if (cm == null) return;
        issue.feedback.push({ result: "more_question", comment: cm, responded_at: now() });
        issue.reopen_count++;
        E.statemachine.transition(issue, "REOPENED", { actor: "접수자", note: "다시 질문: " + cm });
        notify(issue, "질문이 전문가에게 전달되었습니다");
        Store.save(db);
        break;
      }

      /* E-02 근거 점프: 원문 하이라이트 + (음성 유래면) 해당 세그먼트부터 오디오 재생 */
      case "jump": {
        state.hl = {
          input_id: el.getAttribute("data-input"),
          start: parseInt(el.getAttribute("data-start"), 10),
          end: parseInt(el.getAttribute("data-end"), 10)
        };
        state.activeSeg = null;
        var seekTo = null;
        (issue.attachments || []).forEach(function (att, ai) {
          if (seekTo || att.kind !== "audio" || !att.transcript) return;
          var seg = E.media.segmentForRange(att.transcript, state.hl.start, state.hl.end);
          if (seg) {
            state.activeSeg = { media_id: att.media_id, index: att.transcript.indexOf(seg) };
            seekTo = { media_id: att.media_id, ms: seg.start_ms };
          }
        });
        syncOpinionForm();
        render();
        if (seekTo) playAudioSegment(seekTo.media_id, seekTo.ms);
        return;
      }

      /* E-03 AI 분석 */
      case "run-ai": {
        var sc = scenarioOf(issue);
        var gg = E.gap.analyze(MNT, sc, issue.collected);
        issue.ai_analysis = adapter.analyzeIssue({
          collected: issue.collected,
          sufficiency: gg.sufficiency,
          expertChecks: issue.expert_checks,
          equipment: issue.equipment_ref
        });
        E.statemachine.appendAudit(issue, "ai_analysis",
          { verdict: issue.ai_analysis.verdict, confidence: issue.ai_analysis.confidence }, "mock-ai");
        Store.save(db);
        break;
      }
      case "request-field": {
        var items = (issue.ai_analysis.missing_info || []).slice();
        issue.pending_request = { items: items, requested_at: now(), reply: null };
        E.statemachine.transition(issue, "PENDING_FIELD", { actor: "전문가", note: "고객 추가 확인 요청" });
        notify(issue, "현장에서 확인이 필요한 항목이 있습니다");
        Store.save(db);
        break;
      }

      /* E-04 */
      case "ai-draft": {
        syncOpinionForm();
        var free = state.opinionForm.free_text.trim();
        if (!free) { alert("자유 서술을 먼저 입력해 주세요."); return; }
        if (free.length > MAX_FREE_TEXT) {
          alert("자유 서술이 너무 깁니다(" + free.length + "자). " + MAX_FREE_TEXT + "자 이내로 정리해 주세요.");
          return;
        }
        var draft2 = adapter.draftStructuredOpinion(free);
        var f2 = state.opinionForm;
        f2.part_code = draft2.cause_part_code || f2.part_code;
        f2.action_type = draft2.action_type || f2.action_type;
        f2.action_detail = draft2.action_detail || f2.action_detail;
        f2.rationale_text = draft2.rationale_text || f2.rationale_text;
        f2.prevention = draft2.prevention || f2.prevention;
        f2.undetermined = draft2.cause_undetermined && !f2.part_code;
        state.partQuery = "";
        E.statemachine.appendAudit(issue, "ai_opinion_draft",
          { part_code: draft2.cause_part_code, action_type: draft2.action_type }, "mock-ai");
        Store.save(db);
        break;
      }
      case "pick-part": {
        syncOpinionForm();
        state.opinionForm.part_code = el.getAttribute("data-code");
        state.opinionForm.undetermined = false;
        state.partQuery = "";
        break;
      }
      case "finalize-opinion": {
        syncOpinionForm();
        var f3 = state.opinionForm;
        var refs = Object.keys(f3.refs);
        if (!f3.undetermined && !f3.part_code) { alert("확정 원인: 부품 코드를 선택하거나 '원인 미확정'을 체크하세요."); return; }
        if (f3.undetermined && !f3.reason) { alert("원인 미확정 사유 코드를 선택하세요."); return; }
        if (!f3.action_type || !f3.action_detail.trim()) { alert("조치 유형과 조치 내용을 입력하세요."); return; }
        if (refs.length === 0) { alert("판단 근거를 1개 이상 체크하세요."); return; }
        var part3 = f3.part_code ? S.parts.parts.filter(function (p) { return p.part_code === f3.part_code; })[0] : null;
        var sys3 = part3 ? S.parts.systems.filter(function (s) { return s.system_code === part3.system_code; })[0] : null;
        var reason3 = S.undetermined.reasons.filter(function (r) { return r.code === f3.reason; })[0];
        issue.expert_opinion = {
          original_text: f3.free_text,               // 전문가 원본(자유 서술) — 불변 보존(DP-1)
          cause_system_code: sys3 ? sys3.system_code : null,
          cause_system_label: sys3 ? sys3.label : null,
          cause_part_code: f3.undetermined ? null : f3.part_code,
          cause_part_label: part3 && !f3.undetermined ? part3.label : null,
          cause_undetermined: f3.undetermined,
          cause_undetermined_reason: f3.undetermined ? f3.reason : null,
          cause_undetermined_reason_label: f3.undetermined && reason3 ? reason3.label : null,
          action_type: f3.action_type,
          action_detail: f3.action_detail.trim(),
          rationale_refs: refs,
          rationale_text: f3.rationale_text.trim(),
          prevention: f3.prevention.trim(),
          finalized_at: now()
        };
        E.statemachine.appendAudit(issue, "expert_opinion_finalized", {
          part_code: issue.expert_opinion.cause_part_code,
          undetermined: issue.expert_opinion.cause_undetermined,
          action_type: issue.expert_opinion.action_type
        }, "전문가");
        state.opinionForm = null;
        state.rewriteText = null;
        Store.save(db);
        break;
      }

      /* E-05 승인 후 발송 */
      case "approve-send": {
        var rewriteEl = document.getElementById("customer-rewrite");
        var simplified = rewriteEl ? rewriteEl.value.trim() : state.rewriteText;
        var tech5 = issue.expert_opinion.original_text || issue.expert_opinion.rationale_text || "";
        issue.customer_response = {
          technical_original: tech5,      // 전문가 원본은 덮어쓰지 않는다 — 별도 저장(DP-1)
          simplified_response: simplified,
          approved_by: USER.name + "(전문가)",
          approved_at: now(),
          delivered_at: now(),
          delivery_status: "delivered"
        };
        E.statemachine.appendAudit(issue, "customer_response_approved", { by: USER.name }, "전문가");
        E.statemachine.transition(issue, "ANSWERED", { actor: "전문가", note: "승인 후 발송" });
        notify(issue, "전문가 답변이 도착했습니다 — 해결 여부를 알려주세요");
        state.rewriteText = null;
        Store.save(db);
        break;
      }
    }
    render();
  }

  /* ────────────────────────── 이벤트 바인딩 ────────────────────────── */
  root.addEventListener("click", function (ev) {
    var el = ev.target.closest("[data-action]");
    if (!el) return;
    handleAction(el.getAttribute("data-action"), el);
  });
  root.addEventListener("input", function (ev) {
    if (ev.target.id === "part-search") {
      syncOpinionForm();
      state.partQuery = ev.target.value;
      render();
      var ps = document.getElementById("part-search");
      if (ps) { ps.focus(); ps.setSelectionRange(ps.value.length, ps.value.length); }
    }
  });
  root.addEventListener("change", function (ev) {
    if (ev.target.id === "chk-undetermined") {
      syncOpinionForm();
      render();
    }
    if (ev.target.id === "input-image" || ev.target.id === "input-video"
        || ev.target.id === "input-media") {
      // 여러 장을 한 번에 고를 수 있다. 한 장씩만 받으면 현장에서 몇 번을 반복해야 한다.
      var files = ev.target.files ? Array.prototype.slice.call(ev.target.files) : [];
      ev.target.value = "";
      files.forEach(attachFile);
    }
  });
  root.addEventListener("input", function (ev) {
    if (ev.target.id === "input-text") state.c01Text = ev.target.value; // 재렌더에도 입력 유지
  });

  /* 끌어다 놓기.
     화면을 다시 그릴 때마다 요소가 새로 생기므로, 개별 요소가 아니라
     **root 에 한 번만** 걸어 두고 안쪽 요소를 찾아 처리한다.
     (요소마다 걸면 다시 그린 뒤 조용히 동작하지 않는다) */
  ["dragenter", "dragover"].forEach(function (t) {
    root.addEventListener(t, function (ev) {
      var z = ev.target.closest && ev.target.closest("#drop-media");
      if (!z) return;
      ev.preventDefault();
      z.classList.add("over");
    });
  });
  ["dragleave", "drop"].forEach(function (t) {
    root.addEventListener(t, function (ev) {
      var z = ev.target.closest && ev.target.closest("#drop-media");
      if (!z) return;
      ev.preventDefault();
      z.classList.remove("over");
    });
  });
  root.addEventListener("drop", function (ev) {
    var z = ev.target.closest && ev.target.closest("#drop-media");
    if (!z) return;
    ev.preventDefault();
    var files = ev.dataTransfer && ev.dataTransfer.files
      ? Array.prototype.slice.call(ev.dataTransfer.files) : [];
    files.forEach(attachFile);
  });

  /* 창 밖으로 떨어뜨리면 브라우저가 그 파일을 열어 버려 **입력하던 내용이 날아간다.**
     첨부 영역 밖에서는 아무 일도 일어나지 않게 막는다. */
  ["dragover", "drop"].forEach(function (t) {
    window.addEventListener(t, function (ev) {
      if (ev.target.closest && ev.target.closest("#drop-media")) return;
      ev.preventDefault();
    });
  });

  document.getElementById("mode-reporter").addEventListener("click", function () {
    state.mode = "reporter"; state.view = "c04"; state.hl = null; render();
  });
  document.getElementById("mode-expert").addEventListener("click", function () {
    state.mode = "expert"; state.view = "e01"; state.hl = null; render();
  });
  document.getElementById("btn-reset").addEventListener("click", function () {
    if (!confirm("모든 로컬 데이터(이슈 + 첨부 미디어)를 초기화할까요?")) return;
    Store.reset();
    db = Store.load();
    if (window.FI_MEDIA) window.FI_MEDIA.clear().catch(function () {});
    state.mode = "reporter"; state.view = "c04"; state.current = null; state.draft = null;
    state.draftMedia = []; state.c01Text = ""; state.mediaURLs = {}; state.notice = null;
    render();
  });
  var settingsBtn = document.getElementById("btn-settings");
  if (settingsBtn) settingsBtn.addEventListener("click", function () {
    state.settingsOpen = !state.settingsOpen;
    render();
  });
  document.getElementById("btn-load-seed").addEventListener("click", function () {
    if (!window.FI_SEED) { alert("시드 스크립트를 찾을 수 없습니다."); return; }
    var no = window.FI_SEED.load(db, { schema: S, engine: E, adapter: adapter });
    Store.save(db);
    state.mode = "expert"; state.view = "e01"; state.current = no;
    render();
  });

  /* ══════════════════════════ 연결·로그인 ══════════════════════════

     데모 모드와 서버 모드를 화면 위 **띠 하나**로 구분해 알린다.
     지금 어디에 저장되는지 모르고 쓰면, 나중에 "입력한 게 사라졌다"가 된다.
     ─────────────────────────────────────────────────────────────── */

  function banner(kind, detail) {
    var el = document.getElementById("fi-conn");
    if (!el) {
      el = document.createElement("div");
      el.id = "fi-conn";
      el.setAttribute("role", "status");
      document.body.insertBefore(el, document.body.firstChild);
    }
    var map = {
      connecting: ["서버에 연결하는 중…", "#e8edf3", "#334155"],
      server: ["서버에 연결됨 — 접수한 이슈를 전문가가 이어받습니다.", "#e3f4ec", "#0a6045"],
      login: ["로그인이 필요합니다.", "#e8edf3", "#334155"],
      demo: ["이 브라우저에만 저장됩니다 — 다른 사람에게는 보이지 않습니다.", "#fdf4e3", "#7a4f00"]
    };
    var m = map[kind] || map.demo;
    el.style.cssText = "padding:8px 16px;font-size:13px;line-height:1.5;text-align:center;"
      + "background:" + m[1] + ";color:" + m[2] + ";border-bottom:1px solid rgba(0,0,0,.08)";
    el.textContent = m[0] + (detail ? " " + detail : "");
    syncChrome();
  }

  /**
   * 띠와 헤더의 **실제 높이**를 재서 CSS 변수로 알려 준다.
   *
   * 둘 다 fixed 라 흐름에서 빠졌으므로 본문을 그만큼 내려야 첫 줄이 안 가린다.
   * 높이를 숫자로 박아 두면 띠 문구가 길어져 두 줄이 되는 순간 어긋난다 —
   * 좁은 화면에서 실제로 그렇게 된다. 그래서 잰 값을 쓴다.
   */
  function syncChrome() {
    var el = document.getElementById("fi-conn");
    var header = document.querySelector("body > header");
    var bh = el ? Math.round(el.getBoundingClientRect().height) : 0;
    var hh = header ? Math.round(header.getBoundingClientRect().height) : 0;
    var st = document.documentElement.style;
    st.setProperty("--fi-banner-h", bh + "px");
    st.setProperty("--fi-header-h", hh + "px");
    st.setProperty("--fi-chrome-h", (bh + hh) + "px");
  }

  // 글꼴이 늦게 오거나 창 크기가 바뀌면 높이도 바뀐다
  window.addEventListener("resize", syncChrome);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(syncChrome);

  /** 역할에 없는 모드는 버튼째 감춘다 (열어 두면 저장만 막혀 이유를 알 수 없다) */
  function applyRoles() {
    var r = USER.roles || [];
    var only = SERVER && r.length > 0;
    var mr = document.getElementById("mode-reporter");
    var me_ = document.getElementById("mode-expert");
    if (mr) mr.hidden = only && r.indexOf("reporter") === -1;
    if (me_) me_.hidden = only && r.indexOf("expert") === -1 && r.indexOf("admin") === -1;
    if (mr && mr.hidden && state.mode === "reporter") { state.mode = "expert"; state.view = "e01"; }
    if (me_ && me_.hidden && state.mode === "expert") { state.mode = "reporter"; state.view = "c04"; }
  }

  function paintWho() {
    var slot = document.getElementById("auth-slot");
    if (!slot) return;
    if (!SERVER) { slot.innerHTML = ""; return; }
    var roles = (USER.roles || []).join("·") || "역할 없음";
    slot.innerHTML =
      '<span class="auth-who">' + esc(USER.name) + ' <span class="role">' + esc(roles) + '</span></span>' +
      '<button id="btn-signout" class="util" type="button">로그아웃</button>';
    var b = document.getElementById("btn-signout");
    if (b) b.addEventListener("click", function () {
      window.FISupabase.signOut().then(function () { location.reload(); });
    });
  }

  /** 로그인 화면 — 서버 모드인데 세션이 없을 때만 본문 자리에 그린다 */
  function renderLogin(msg) {
    banner("login");
    root.innerHTML =
      '<section class="card" style="max-width:420px;margin:32px auto">' +
        '<h2>로그인</h2>' +
        '<p class="muted">현장에서 접수한 이슈를 전문가가 이어받으려면 계정이 필요합니다. ' +
          '계정은 관리자가 Supabase 대시보드에서 만들어 줍니다.</p>' +
        (msg ? '<p class="warn-line" style="color:#c8341f">' + esc(msg) + '</p>' : '') +
        '<label class="fld" for="li-email">이메일</label>' +
        '<input id="li-email" type="text" autocomplete="username" inputmode="email">' +
        '<label class="fld" for="li-pw">비밀번호</label>' +
        '<input id="li-pw" type="password" autocomplete="current-password">' +
        '<div style="margin-top:14px"><button id="li-go" class="primary" type="button">로그인</button></div>' +
      '</section>';
    var go = document.getElementById("li-go");
    var pw = document.getElementById("li-pw");
    function submit() {
      var em = (document.getElementById("li-email") || {}).value || "";
      var pass = (pw || {}).value || "";
      if (!em.trim() || !pass) { renderLogin("이메일과 비밀번호를 모두 입력하세요."); return; }
      go.disabled = true; go.textContent = "확인 중…";
      window.FISupabase.signIn(em.trim(), pass)
        .then(startServer)
        .catch(function (e) {
          renderLogin("로그인하지 못했습니다 — " + ((e && e.message) || e));
        });
    }
    if (go) go.addEventListener("click", submit);
    if (pw) pw.addEventListener("keydown", function (ev) { if (ev.key === "Enter") submit(); });
  }

  /** 로그인 뒤 — 내 역할을 읽고 서버 자료로 화면을 채운다 */
  function startServer() {
    banner("connecting");
    return window.FISupabase.loadMe().then(function (m) {
      if (m) USER = { name: m.name || m.email, roles: m.roles || [] };
      if (!m || !(m.roles || []).length) {
        banner("server", "이 계정은 아직 역할이 없습니다 — 관리자에게 app_user 등록을 요청하세요.");
      }
      return window.FISupabase.loadDb();
    }).then(function (loaded) {
      SERVER = true;
      window.FISupabase.setMode("server");
      db = loaded;
      banner("server");
      applyRoles();
      paintWho();
      state.view = state.mode === "expert" ? "e01" : "c04";
      render();
    }).catch(function (err) {
      var msg = (err && err.message) || String(err);
      var hint = /relation .* does not exist|schema cache/i.test(msg)
        ? " supabase/schema.sql 을 SQL Editor 에서 실행했는지 확인하세요."
        : "";
      banner("demo", "(연결 실패: " + msg + ")" + hint);
      SERVER = false;
      render();
    });
  }

  function boot() {
    if (window.FISupabase) {
      window.FISupabase.onNotify(function (msg) { banner("demo", "(" + msg.split("\n")[0] + ")"); });
    }
    if (!window.FISupabase || !window.FISupabase.available()) {
      banner("demo");
      render();
      return;
    }
    banner("connecting");
    window.FISupabase.session().then(function (sess) {
      if (!sess) { renderLogin(); return; }
      return startServer();
    }).catch(function (e) {
      banner("demo", "(연결 실패: " + ((e && e.message) || e) + ")");
      render();
    });
  }

  boot();
})();
