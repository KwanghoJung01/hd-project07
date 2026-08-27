/**
 * media.js — 미디어 첨부·전사(transcript) 순수 로직 (MVP-2/3 고도화)
 *
 * - 파일 크기/유형 검증 (영상 기본 50MB 제한 — FR-27 보존 정책과 연동되는 설정 상수)
 * - STT 세그먼트 전사 구조: transcript[] = {text, start_ms, end_ms} (원문 13장 UserInput.transcript 스키마)
 * - 세그먼트 ↔ 최종 텍스트 char offset 매핑 → 음성 유래 필드의 근거 점프(E-02)에 사용
 * - 영상 프레임 추출 파라미터 계산 (비전 분석용 최대 3장)
 *
 * DOM/브라우저 API 의존 없음 — Node 단위 테스트 대상. UMD 모듈.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.FI = root.FI || {};
    root.FI.media = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var MB = 1024 * 1024;

  /** 용량 제한(설정 상수). 영상 50MB — 초과 시 업로드 거부 + 명확한 안내 */
  var LIMITS = {
    audio: 20 * MB,
    image: 10 * MB,
    video: 50 * MB
  };

  var KIND_LABELS = { audio: "음성", image: "이미지", video: "영상" };

  function kindOf(mimeType) {
    var t = String(mimeType || "");
    if (t.indexOf("audio/") === 0) return "audio";
    if (t.indexOf("image/") === 0) return "image";
    if (t.indexOf("video/") === 0) return "video";
    return null;
  }

  function formatBytes(n) {
    if (n == null || isNaN(n)) return "-";
    if (n < 1024) return n + "B";
    if (n < MB) return (n / 1024).toFixed(1) + "KB";
    return (n / MB).toFixed(1) + "MB";
  }

  function formatDuration(sec) {
    if (sec == null || isNaN(sec)) return "";
    var s = Math.max(0, Math.round(sec));
    var m = Math.floor(s / 60);
    return m + ":" + ((s % 60) < 10 ? "0" : "") + (s % 60);
  }

  /**
   * 첨부 파일 검증.
   * @param {{name, type, size}} file
   * @returns {{ok:true, kind}} | {{ok:false, error}}
   */
  function validateFile(file) {
    var kind = kindOf(file && file.type);
    if (!kind) {
      return { ok: false, error: "지원하지 않는 파일 형식입니다: " + ((file && file.type) || "알 수 없음") };
    }
    var limit = LIMITS[kind];
    if (file.size > limit) {
      return {
        ok: false,
        error: KIND_LABELS[kind] + " 용량 초과 — " + formatBytes(file.size) +
          " (허용: " + formatBytes(limit) + " 이하). 짧게 나눠 촬영하거나 압축 후 다시 첨부해 주세요."
      };
    }
    return { ok: true, kind: kind };
  }

  /**
   * 영상 프레임 추출 시점 계산(초). 비전 분석에 최대 maxFrames장.
   * 짧은 영상은 중복 없이, 긴 영상은 10%/50%/90% 지점.
   */
  function frameTimes(durationSec, maxFrames) {
    if (maxFrames == null) maxFrames = 3;
    if (!durationSec || durationSec <= 0 || isNaN(durationSec)) return [0];
    if (durationSec < 2 || maxFrames === 1) return [durationSec / 2];
    var ratios = maxFrames === 2 ? [0.25, 0.75] : [0.1, 0.5, 0.9];
    var seen = {};
    return ratios.slice(0, maxFrames).map(function (r) {
      return Math.round(durationSec * r * 10) / 10;
    }).filter(function (t) {
      var k = String(t);
      if (seen[k]) return false;
      seen[k] = true;
      return true;
    });
  }

  /** STT 세그먼트 배열 → 이어붙인 텍스트 + 세그먼트별 char offset */
  function buildTranscript(segments) {
    var text = "";
    var out = (segments || []).map(function (s) {
      var piece = String(s.text || "").trim();
      if (text && piece) text += " ";
      var start = text.length;
      text += piece;
      return {
        text: piece,
        start_ms: s.start_ms,
        end_ms: s.end_ms,
        char_start: start,
        char_end: start + piece.length
      };
    });
    return { text: text, segments: out };
  }

  /**
   * 최종 입력 텍스트(사용자 편집 포함) 안에서 각 세그먼트의 char 위치를 찾는다.
   * 순차 탐색(indexOf) — 편집으로 사라진 세그먼트는 char_start=-1 (근거 점프는 오디오 재생만 가능).
   */
  function locateSegments(fullText, segments) {
    var cursor = 0;
    return (segments || []).map(function (s) {
      var piece = String(s.text || "").trim();
      var idx = piece ? fullText.indexOf(piece, cursor) : -1;
      if (idx < 0 && piece) idx = fullText.indexOf(piece); // 편집으로 순서가 바뀐 경우 전체 재탐색
      if (idx >= 0) cursor = idx + piece.length;
      return {
        text: piece,
        start_ms: s.start_ms,
        end_ms: s.end_ms,
        char_start: idx,
        char_end: idx >= 0 ? idx + piece.length : -1
      };
    });
  }

  /** char 구간 [start, end) 과 겹치는 첫 세그먼트 (근거 점프 → 오디오 seek) */
  function segmentForRange(segments, start, end) {
    if (end == null) end = start + 1;
    for (var i = 0; i < (segments || []).length; i++) {
      var s = segments[i];
      if (s.char_start == null || s.char_start < 0) continue;
      if (start < s.char_end && end > s.char_start) return s;
    }
    return null;
  }

  return {
    LIMITS: LIMITS,
    KIND_LABELS: KIND_LABELS,
    kindOf: kindOf,
    formatBytes: formatBytes,
    formatDuration: formatDuration,
    validateFile: validateFile,
    frameTimes: frameTimes,
    buildTranscript: buildTranscript,
    locateSegments: locateSegments,
    segmentForRange: segmentForRange
  };
});
