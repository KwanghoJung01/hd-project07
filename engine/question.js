/**
 * question.js — Question Engine (FR-08, 원문 8장)
 *
 * DecisionImpact(r) = 판별력(r) × 획득가능성 계수(r) × 미확보도(r)
 *   판별력      : 스키마 사전 정의 정수 가중치 (LLM 산정 금지)
 *   획득가능성  : 상=1.0 / 중=0.6 / 하=0.1 / 자동=0 (schema.obtainability_factors)
 *   미확보도    : 미확보=1 / 부분 확보=0.5 / 확보=0
 *
 * 질문 선정 원칙(8.1):
 *   P1 세션당 최대 3개 / P2 판단을 바꿀 정보만 / P3 선택지형 기본
 *   P4 모든 질문에 [모르겠음] 포함 / P5 자동 획득 항목(MNT-12)은 질문하지 않음
 *   획득가능성 '하'(MNT-10/11)는 절대 질문하지 않고 "전문가 추가 확인 항목"으로 넘긴다.
 *
 * UMD 모듈: 브라우저 window.FI.question / Node require 양쪽 지원.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./gap.js"));
  } else {
    root.FI = root.FI || {};
    root.FI.question = factory(root.FI.gap);
  }
})(typeof self !== "undefined" ? self : this, function (gap) {
  "use strict";

  var UNKNOWN_OPTION = "모르겠음";

  function uncoveredFactor(coverage, schema) {
    var table = (schema && schema.uncovered_factors) || { uncovered: 1, partial: 0.5, covered: 0 };
    var v = table[coverage];
    return v == null ? 1 : v;
  }

  /** DecisionImpact 계산 */
  function decisionImpact(requirement, coverage, schema) {
    var factors = (schema && schema.obtainability_factors) || {};
    var f = factors[requirement.obtainability];
    if (f == null) f = 0;
    return requirement.discriminative_weight * f * uncoveredFactor(coverage, schema);
  }

  /**
   * 질문 생성: DecisionImpact 상위 최대 N개(기본 3).
   * @param {Object} schema maintenance.requirements.json
   * @param {Object} scenario 시나리오
   * @param {Array} collected 현재까지 확보한 CollectedInformation
   * @returns Question[] — {question_id, requirement_id, label, question_text, options[], answer_type, decision_impact}
   */
  function generateQuestions(schema, scenario, collected, maxN) {
    if (maxN == null) maxN = schema.question_budget || 3;
    var byReq = {};
    (collected || []).forEach(function (c) { byReq[c.requirement_id] = c; });

    var candidates = gap.scenarioRequirements(schema, scenario)
      .filter(function (req) { return req.ask_policy === "ask"; }) // '하'=expert_check, '자동'=auto_acquire 제외
      .map(function (req) {
        var item = byReq[req.requirement_id];
        var coverage = gap.coverageOf(item);
        // unknown/skipped 로 명시된 항목은 재질문하지 않는다(P4: 강제 응답 금지)
        var answeredExplicitly = item && (item.value_state === "unknown" || item.value_state === "skipped");
        return {
          requirement: req,
          coverage: coverage,
          excluded: !!answeredExplicitly,
          impact: decisionImpact(req, coverage, schema)
        };
      })
      .filter(function (c) { return !c.excluded && c.impact > 0; });

    candidates.sort(function (a, b) {
      if (b.impact !== a.impact) return b.impact - a.impact;
      return a.requirement.priority - b.requirement.priority; // 동점이면 스키마 priority
    });

    return candidates.slice(0, maxN).map(function (c, i) {
      var options = (c.requirement.options || []).slice();
      if (options.indexOf(UNKNOWN_OPTION) < 0) options.push(UNKNOWN_OPTION); // P4
      return {
        question_id: "Q" + (i + 1) + "-" + c.requirement.requirement_id,
        requirement_id: c.requirement.requirement_id,
        label: c.requirement.label,
        question_text: c.requirement.question_text,
        answer_type: c.requirement.answer_type,
        options: options,
        decision_impact: c.impact,
        answer: null,
        answered_at: null
      };
    });
  }

  /** 획득가능성 '하' 항목 중 미확보 → 전문가 추가 확인 항목 */
  function expertCheckItems(schema, scenario, collected) {
    var byReq = {};
    (collected || []).forEach(function (c) { byReq[c.requirement_id] = c; });
    return gap.scenarioRequirements(schema, scenario)
      .filter(function (req) {
        return req.ask_policy === "expert_check" &&
          gap.coverageOf(byReq[req.requirement_id]) !== "covered";
      })
      .map(function (req) {
        return { requirement_id: req.requirement_id, label: req.label, note: req.note || "" };
      });
  }

  return {
    UNKNOWN_OPTION: UNKNOWN_OPTION,
    decisionImpact: decisionImpact,
    generateQuestions: generateQuestions,
    expertCheckItems: expertCheckItems
  };
});
