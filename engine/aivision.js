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
    openai: "gpt-4o"
  };

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
   * 어댑터 생성. provider/api_key 미설정이면 null (기본 경로 = 오프라인 규칙 엔진).
   * @param {Object} settings {provider:"claude"|"openai", api_key, model}
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
          if (!res.ok) throw new Error("미디어 분석 요청 실패 (HTTP " + res.status + ")");
          return res.json();
        })
        .then(function (json) {
          var text = provider === "claude"
            ? (json.content && json.content[0] && json.content[0].text)
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
    parseDataURI: parseDataURI,
    parseFindings: parseFindings,
    createVisionAdapter: createVisionAdapter
  };
});
