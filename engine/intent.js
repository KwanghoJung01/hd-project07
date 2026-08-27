/**
 * intent.js — Intent 분류기 + 안전 위험 감지 (FR-04, FR-05)
 *
 * 키워드 규칙 기반 Mock AI Router.
 * - Domain 분류: schema/domains.json 의 도메인별 키워드 매칭(최다 매칭 도메인 선택)
 * - 안전 위험: safety_keywords 매칭 시 safety_flag=true → 정보수집 중단 + 긴급 경고로 분기
 *
 * UMD 모듈: 브라우저 window.FI.intent / Node require 양쪽 지원.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.FI = root.FI || {};
    root.FI.intent = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function findHits(text, keywords) {
    var hits = [];
    (keywords || []).forEach(function (kw) {
      var idx = text.indexOf(kw);
      if (idx >= 0) hits.push({ keyword: kw, start: idx, end: idx + kw.length });
    });
    return hits;
  }

  /**
   * 안전 위험 감지 (FR-05). 위험 키워드가 하나라도 있으면 true.
   * @returns {{flag: boolean, hits: Array}}
   */
  function detectSafety(text, domainsSchema) {
    var hits = findHits(String(text || ""), domainsSchema.safety_keywords);
    return { flag: hits.length > 0, hits: hits };
  }

  /**
   * Intent 분류 (FR-04).
   * @param {string} text 사용자 원문
   * @param {Object} domainsSchema schema/domains.json
   * @returns {{domain, domain_label, intent, confidence, safety_flag, safety_hits, matched_keywords}}
   */
  function classify(text, domainsSchema) {
    var t = String(text || "");
    var safety = detectSafety(t, domainsSchema);

    var best = null;
    var bestHits = [];
    (domainsSchema.domains || []).forEach(function (d) {
      var hits = findHits(t, d.keywords);
      if (hits.length > (bestHits.length || 0) && hits.length > 0) {
        best = d;
        bestHits = hits;
      }
    });

    var etc = (domainsSchema.domains || []).filter(function (d) { return d.code === "etc"; })[0];
    var domain = best || etc || { code: "etc", label: "기타" };
    // 분류 confidence: 키워드 매칭 수 기반 규칙(출처 기반 원칙과 별개인 라우팅 참고값)
    var conf = best ? Math.min(0.95, 0.5 + 0.15 * bestHits.length) : 0.3;

    var intentCode = null;
    if (domain.code === "maintenance") {
      intentCode = /경고등|알람|램프가 켜/.test(t) ? "warning_lamp" : "abnormal_symptom";
    }

    return {
      domain: domain.code,
      domain_label: domain.label,
      intent: intentCode,
      confidence: conf,
      safety_flag: safety.flag,
      safety_hits: safety.hits,
      matched_keywords: bestHits
    };
  }

  return {
    classify: classify,
    detectSafety: detectSafety
  };
});
