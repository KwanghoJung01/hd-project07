/**
 * aivision.js — 선택 정밀 모드: 이미지/영상 프레임 비전 분석 어댑터 (MVP-3 고도화)
 *
 * 기본 경로는 완전 오프라인 Mock 규칙 엔진이며, 이 어댑터는
 * **사용자가 설정에서 제공사·API 키를 직접 입력한 경우에만** 생성·호출된다.
 * 실패해도 기능 저하 없이 안내만 하고 규칙 엔진 결과는 항상 유지된다.
 *
 * 반환 스키마(구조화): { summary(현상 요약), observed[](보이는 장비/부품), hazards[](위험 신호) }
 * → Issue.media_findings 로 병합, E-03 "미디어 분석" 섹션에 표시.
 *
 * fetch 주입 가능 — Node 단위 테스트 대상. UMD 모듈.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.FI = root.FI || {};
    root.FI.aivision = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var DEFAULT_MODELS = {
    claude: "claude-opus-5",
    openai: "gpt-4o",
    gemini: "gemini-3.6-flash"
  };

  /**
   * Gemini 무료 티어에서 고를 수 있는 모델 (설정 화면 드롭다운용).
   * 값 = generativelanguage API 에 그대로 보내는 모델 ID.
   * 새 모델(gemini-3.7-flash 등)은 설정의 "모델 직접 입력" 으로 코드 수정 없이 대응.
   */
  var GEMINI_MODELS = [
    { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash-Lite (무료 한도 넉넉·가벼움)" },
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    { id: "gemini-3.6-flash", label: "Gemini 3.6 Flash (최신·무료)" }
  ];

  var PROMPT =
    "당신은 건설장비(굴착기) 정비 접수를 돕는 분석가입니다. 첨부된 현장 사진을 보고 " +
    "반드시 아래 키를 가진 JSON 객체만 출력하세요(다른 텍스트 금지):\n" +
    '{"summary":"현상 한 줄 요약(한국어)","observed":["보이는 장비/부품(한국어)"],' +
    '"hazards":["화재·연기·누유 등 위험 신호(없으면 빈 배열)"]}';

  /** data URI → {media_type, base64} (순수 함수 — 단위 테스트 대상) */
  function parseDataURI(uri) {
    var m = /^data:([^;,]+)(;base64)?,(.*)$/.exec(String(uri || ""));
    if (!m || !m[2]) return null;
    return { media_type: m[1], base64: m[3] };
  }

  /** 모델 응답 텍스트에서 JSON 추출 (코드펜스/부가 텍스트 허용) */
  function parseFindings(text) {
    var t = String(text || "");
    var start = t.indexOf("{");
    var end = t.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      var obj = JSON.parse(t.slice(start, end + 1));
      return {
        summary: String(obj.summary || ""),
        observed: Array.isArray(obj.observed) ? obj.observed.map(String) : [],
        hazards: Array.isArray(obj.hazards) ? obj.hazards.map(String) : []
      };
    } catch (e) { return null; }
  }

  /**
   * HTTP 오류를 그대로 문자열로 던지지 않고, 앱이 사용자에게 친절히 안내할 수 있도록
   * 구조를 붙여 던진다. 특히 429(RESOURCE_EXHAUSTED)는 "일일 소진 / 분당 초과"를 구분한다.
   */
  function httpError(status, body) {
    var msg = "AI 분석 요청 실패 (HTTP " + status + ")";
    var err = new Error(msg);
    err.status = status;
    if (status === 429) {
      err.quota = true;
      // RetryInfo.retryDelay 가 있으면 분당 한도(잠시 후 재시도 가능), 없으면 일일 소진으로 본다
      var retry = null;
      try {
        var details = (body && body.error && body.error.details) || [];
        for (var i = 0; i < details.length; i++) {
          var d = details[i] || {};
          if (/RetryInfo/.test(d["@type"] || "") && d.retryDelay) {
            retry = Math.ceil(parseFloat(String(d.retryDelay).replace(/[^0-9.]/g, "")) || 0);
          }
        }
      } catch (e) { /* 형식이 달라도 무시 */ }
      err.retryAfterSec = retry;
      err.daily = retry == null;
    }
    return err;
  }

  /**
   * 어댑터 생성. provider/api_key 미설정이면 null (기본 경로 = 오프라인 규칙 엔진).
   * @param {Object} settings {provider:"gemini"|"claude"|"openai", api_key, model}
   * @param {Function} [fetchImpl]
   */
  function createVisionAdapter(settings, fetchImpl) {
    settings = settings || {};
    var provider = settings.provider;
    var key = (settings.api_key || "").trim();
    if (!provider || provider === "none" || !key) return null;
    var doFetch = fetchImpl || (typeof fetch !== "undefined" ? fetch.bind(typeof self !== "undefined" ? self : this) : null);
    if (!doFetch) return null;
    var model = settings.model || DEFAULT_MODELS[provider];

    /**
     * @param {Object} input {images: [dataURI...], context: 접수 텍스트}
     * @returns Promise<{summary, observed[], hazards[], provider, model}>
     */
    function analyzeMedia(input) {
      var images = (input.images || []).slice(0, 3);
      if (!images.length) return Promise.resolve(null);
      var userText = PROMPT + (input.context ? "\n\n접수자 설명: " + input.context : "");

      var url, headers, body;
      if (provider === "claude") {
        url = "https://api.anthropic.com/v1/messages";
        headers = {
          "content-type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true"
        };
        var content = images.map(function (uri) {
          var p = parseDataURI(uri);
          return { type: "image", source: { type: "base64", media_type: p.media_type, data: p.base64 } };
        });
        content.push({ type: "text", text: userText });
        body = { model: model, max_tokens: 1024, messages: [{ role: "user", content: content }] };
      } else if (provider === "gemini") {
        // generativelanguage API 는 브라우저 직접 호출(CORS)을 허용한다 → Phase 1 에 맞다.
        url = "https://generativelanguage.googleapis.com/v1beta/models/" +
              encodeURIComponent(model) + ":generateContent";
        headers = { "content-type": "application/json", "x-goog-api-key": key };
        var gParts = [{ text: userText }];
        images.forEach(function (uri) {
          var gp = parseDataURI(uri);
          if (gp) gParts.push({ inline_data: { mime_type: gp.media_type, data: gp.base64 } });
        });
        body = {
          contents: [{ role: "user", parts: gParts }],
          generationConfig: { responseMimeType: "application/json", temperature: 0 }
        };
      } else {
        url = "https://api.openai.com/v1/chat/completions";
        headers = { "content-type": "application/json", Authorization: "Bearer " + key };
        var parts = [{ type: "text", text: userText }];
        images.forEach(function (uri) {
          parts.push({ type: "image_url", image_url: { url: uri } });
        });
        body = {
          model: model,
          response_format: { type: "json_object" },
          messages: [{ role: "user", content: parts }]
        };
      }

      return doFetch(url, { method: "POST", headers: headers, body: JSON.stringify(body) })
        .then(function (res) {
          if (!res.ok) {
            return res.json().catch(function () { return null; }).then(function (errBody) {
              throw httpError(res.status, errBody);
            });
          }
          return res.json();
        })
        .then(function (json) {
          var text = provider === "claude"
            ? (json.content && json.content[0] && json.content[0].text)
            : provider === "gemini"
              ? (json.candidates && json.candidates[0] && json.candidates[0].content &&
                 json.candidates[0].content.parts && json.candidates[0].content.parts[0] &&
                 json.candidates[0].content.parts[0].text)
              : (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content);
          var findings = parseFindings(text);
          if (!findings) throw new Error("미디어 분석 응답을 해석하지 못했습니다.");
          findings.provider = provider;
          findings.model = model;
          findings.image_count = images.length;
          return findings;
        });
    }

    return { provider: provider, model: model, analyzeMedia: analyzeMedia };
  }

  return {
    DEFAULT_MODELS: DEFAULT_MODELS,
    GEMINI_MODELS: GEMINI_MODELS,
    parseDataURI: parseDataURI,
    parseFindings: parseFindings,
    httpError: httpError,
    createVisionAdapter: createVisionAdapter
  };
});
