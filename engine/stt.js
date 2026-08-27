/**
 * stt.js — STT(음성→텍스트) 어댑터 (MVP-2 고도화)
 *
 * 기본: Web Speech API(webkitSpeechRecognition) — 무료·키 불필요(크롬/엣지, 네트워크 필요).
 *   녹음과 동시에 실시간 전사, 각 final 결과를 녹음 시작 기준 ms 세그먼트로 기록
 *   → transcript[] {text, start_ms, end_ms} (원문 13장 스키마, word-timestamp의 세그먼트 근사).
 * 대안: Whisper API 어댑터 — 사용자 API 키 입력 시에만 동작(키는 localStorage에만 보관).
 *
 * 생성자/시계를 주입받아 브라우저 없이도 단위 테스트 가능. UMD 모듈.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.FI = root.FI || {};
    root.FI.stt = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /** 브라우저 환경에서 Web Speech API 지원 여부 */
  function supported(env) {
    env = env || (typeof window !== "undefined" ? window : {});
    return !!(env.__FI_TEST_SR || env.SpeechRecognition || env.webkitSpeechRecognition);
  }

  /**
   * Web Speech 실시간 전사기.
   * @param {Object} opts {Impl: SpeechRecognition 생성자(테스트 주입용), now: ()=>ms, lang}
   * @returns {{start, stop, onsegment, oninterim, onerror, onend, segments}}
   */
  function createWebSpeechSTT(opts) {
    opts = opts || {};
    var env = typeof window !== "undefined" ? window : {};
    var Impl = opts.Impl || env.__FI_TEST_SR || env.SpeechRecognition || env.webkitSpeechRecognition;
    var now = opts.now || function () { return Date.now(); };

    var api = {
      segments: [],
      onsegment: null, oninterim: null, onerror: null, onend: null,
      start: start, stop: stop
    };
    var rec = null;
    var t0 = 0;
    var lastEndMs = 0;
    var stopping = false;

    function start() {
      if (!Impl) throw new Error("Web Speech API 미지원 브라우저입니다.");
      api.segments = [];
      t0 = now();
      lastEndMs = 0;
      stopping = false;
      rec = new Impl();
      rec.lang = opts.lang || "ko-KR";
      rec.continuous = true;
      rec.interimResults = true;
      rec.onresult = function (ev) {
        var interim = "";
        for (var i = ev.resultIndex; i < ev.results.length; i++) {
          var res = ev.results[i];
          var text = (res[0] && res[0].transcript) || "";
          if (res.isFinal) {
            var endMs = now() - t0;
            var seg = { text: text.trim(), start_ms: lastEndMs, end_ms: endMs };
            lastEndMs = endMs;
            if (seg.text) {
              api.segments.push(seg);
              if (api.onsegment) api.onsegment(seg);
            }
          } else {
            interim += text;
          }
        }
        if (interim && api.oninterim) api.oninterim(interim);
      };
      rec.onerror = function (ev) {
        if (api.onerror) api.onerror(ev && ev.error ? ev.error : "stt_error");
      };
      rec.onend = function () {
        // 사용자가 정지하기 전 브라우저가 세션을 끊으면 자동 재시작(연속 전사)
        if (!stopping && rec) {
          try { rec.start(); return; } catch (e) { /* 재시작 실패 → 종료 처리 */ }
        }
        if (api.onend) api.onend(api.segments);
      };
      rec.start();
    }

    function stop() {
      stopping = true;
      if (rec) { try { rec.stop(); } catch (e) {} }
    }

    return api;
  }

  /**
   * Whisper API 어댑터(선택) — 녹음 파일 업로드 방식.
   * verbose_json 응답이면 세그먼트 타임스탬프까지, 아니면 전체를 1세그먼트로 반환.
   * @param {Object} opts {apiKey, fetchImpl, model, endpoint}
   */
  function createWhisperSTT(opts) {
    opts = opts || {};
    var fetchImpl = opts.fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
    var endpoint = opts.endpoint || "https://api.openai.com/v1/audio/transcriptions";
    var model = opts.model || "whisper-1";

    function transcribe(blob, filename, durationMs) {
      if (!opts.apiKey) return Promise.reject(new Error("API 키가 없습니다. 설정에서 키를 입력하세요."));
      if (!fetchImpl) return Promise.reject(new Error("fetch 를 사용할 수 없는 환경입니다."));
      var fd = new FormData();
      fd.append("file", blob, filename || "recording.webm");
      fd.append("model", model);
      fd.append("response_format", "verbose_json");
      fd.append("language", "ko");
      return fetchImpl(endpoint, {
        method: "POST",
        headers: { Authorization: "Bearer " + opts.apiKey },
        body: fd
      }).then(function (res) {
        if (!res.ok) throw new Error("STT 요청 실패 (HTTP " + res.status + ")");
        return res.json();
      }).then(function (json) {
        return parseWhisperResponse(json, durationMs);
      });
    }

    return { transcribe: transcribe };
  }

  /** Whisper 응답 → transcript 세그먼트 (순수 함수 — 단위 테스트 대상) */
  function parseWhisperResponse(json, durationMs) {
    if (json && Array.isArray(json.segments) && json.segments.length) {
      return json.segments.map(function (s) {
        return {
          text: String(s.text || "").trim(),
          start_ms: Math.round((s.start || 0) * 1000),
          end_ms: Math.round((s.end || 0) * 1000)
        };
      }).filter(function (s) { return s.text; });
    }
    var text = json && json.text ? String(json.text).trim() : "";
    if (!text) return [];
    return [{ text: text, start_ms: 0, end_ms: durationMs || 0 }];
  }

  return {
    supported: supported,
    createWebSpeechSTT: createWebSpeechSTT,
    createWhisperSTT: createWhisperSTT,
    parseWhisperResponse: parseWhisperResponse
  };
});
