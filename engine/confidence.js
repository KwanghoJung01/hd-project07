/**
 * confidence.js — 출처 기반 신뢰도 산정기 (원문 9.2, FR-09)
 *
 * LLM 자기보고 confidence는 신뢰할 수 없으므로 "값의 출처"만으로 산정한다.
 * confidence < 0.7 인 필드를 판단영향도 순으로 정렬해 상위 2개만 확인 대상으로 반환한다(DP-4).
 *
 * 브라우저(window.FI.confidence)와 Node(require) 양쪽에서 동작하는 UMD 모듈.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.FI = root.FI || {};
    root.FI.confidence = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /** 값의 출처 → confidence (원문 9.2 표 그대로) */
  var SOURCE_CONFIDENCE = {
    uttered: 0.95,   // 사용자가 명시적으로 발화
    answered: 0.99,  // 선택지 질문에 직접 응답
    system: 1.0,     // 시스템 자동 획득(장비 식별 등)
    inferred: 0.6,   // 문맥에서 추론 → 확인 대상
    "default": 0.4,  // 유사 사례에서 기본값 보완 → 확인 대상
    ambiguous: 0.5   // 표현이 모호/다의적 → 확인 대상
  };

  var CONFIRM_THRESHOLD = 0.7; // 이 미만이면 확인 대상
  var CONFIRM_MAX = 2;         // 강조 확인은 최대 2개(DP-4). 3개 이상이면 질문 단계로 되돌린다.

  /** 출처 유형으로 confidence를 반환한다. 미정의 출처는 default(0.4) 취급. */
  function confidenceFor(sourceType) {
    if (Object.prototype.hasOwnProperty.call(SOURCE_CONFIDENCE, sourceType)) {
      return SOURCE_CONFIDENCE[sourceType];
    }
    return SOURCE_CONFIDENCE["default"];
  }

  /**
   * 확인 대상 필드 선정.
   * @param {Array} collected CollectedInformation 배열 ({requirement_id, confidence, value_state} 포함)
   * @param {Object} schema   maintenance.requirements.json
   * @param {number} [maxN]   기본 2
   * @returns confidence < 0.7 인 known 필드를 판단영향도(판별력 × 획득가능성 계수) 내림차순 정렬 후 상위 maxN개
   */
  function confirmTargets(collected, schema, maxN) {
    if (maxN == null) maxN = schema && schema.confirm_max ? schema.confirm_max : CONFIRM_MAX;
    var threshold = schema && schema.confirm_threshold ? schema.confirm_threshold : CONFIRM_THRESHOLD;
    var reqById = {};
    (schema.requirements || []).forEach(function (r) { reqById[r.requirement_id] = r; });
    var factors = schema.obtainability_factors || {};

    function impactOf(item) {
      var r = reqById[item.requirement_id];
      if (!r) return 0;
      var f = factors[r.obtainability];
      if (f == null) f = 0;
      return r.discriminative_weight * f;
    }

    return collected
      .filter(function (c) {
        return c && c.value_state === "known" && typeof c.confidence === "number" && c.confidence < threshold;
      })
      .sort(function (a, b) { return impactOf(b) - impactOf(a); })
      .slice(0, maxN);
  }

  return {
    SOURCE_CONFIDENCE: SOURCE_CONFIDENCE,
    CONFIRM_THRESHOLD: CONFIRM_THRESHOLD,
    CONFIRM_MAX: CONFIRM_MAX,
    confidenceFor: confidenceFor,
    confirmTargets: confirmTargets
  };
});
