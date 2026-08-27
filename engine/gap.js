/**
 * gap.js — Requirement Schema 적용 + Information Gap 분석 (FR-06, FR-07)
 *
 * - 시나리오 선택: 입력 텍스트의 trigger_keywords 로 정보요건 집합을 동적으로 선택(Dynamic Requirement Identification)
 * - 필드 추출: 스키마의 extract 키워드 규칙으로 입력 텍스트에서 값 추출.
 *   모든 추출 값은 evidence_ref(input_id + 원문 char offset)를 가진다(DP-2).
 *   텍스트 모드의 char offset은 음성 모드 word-timestamp(start_ms/end_ms)와 동일한 위치의 스키마다.
 * - Gap 분석: 필요 − 확보 = Gap, 정보충분도(%) 계산
 *
 * UMD 모듈: 브라우저 window.FI.gap / Node require 양쪽 지원.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./confidence.js"));
  } else {
    root.FI = root.FI || {};
    root.FI.gap = factory(root.FI.confidence);
  }
})(typeof self !== "undefined" ? self : this, function (confidence) {
  "use strict";

  /** 입력 텍스트로 시나리오(정보요건 집합)를 선택한다. */
  function pickScenario(text, schema) {
    var t = String(text || "");
    var scenarios = schema.scenarios || [];
    for (var i = 0; i < scenarios.length; i++) {
      var s = scenarios[i];
      var trig = s.trigger_keywords || [];
      for (var j = 0; j < trig.length; j++) {
        if (t.indexOf(trig[j]) >= 0) return s;
      }
    }
    var def = scenarios.filter(function (s) { return s["default"]; })[0];
    return def || scenarios[0] || null;
  }

  /** 시나리오에 속한 Requirement 객체 목록 */
  function scenarioRequirements(schema, scenario) {
    var byId = {};
    (schema.requirements || []).forEach(function (r) { byId[r.requirement_id] = r; });
    return (scenario.requirement_ids || []).map(function (id) { return byId[id]; }).filter(Boolean);
  }

  function matchRule(text, rule) {
    var anyHit = null;
    var any = rule.any || [];
    for (var i = 0; i < any.length; i++) {
      var idx = text.indexOf(any[i]);
      if (idx >= 0) { anyHit = { keyword: any[i], start: idx, end: idx + any[i].length }; break; }
    }
    if (!anyHit) return null;
    var all = rule.all || [];
    for (var j = 0; j < all.length; j++) {
      if (text.indexOf(all[j]) < 0) return null;
    }
    return anyHit;
  }

  /**
   * 키워드 규칙 기반 필드 추출.
   * @param {string} text 사용자 원문
   * @param {Object} schema maintenance.requirements.json
   * @param {Object} scenario pickScenario 결과
   * @param {string} [inputId] evidence_ref.input_id 로 기록할 원본 입력 ID
   * @returns CollectedInformation[] (추출된 필드만)
   */
  function extract(text, schema, scenario, inputId) {
    var t = String(text || "");
    var collected = [];
    scenarioRequirements(schema, scenario).forEach(function (req) {
      var rules = req.extract || [];
      for (var i = 0; i < rules.length; i++) {
        var hit = matchRule(t, rules[i]);
        if (hit) {
          var source = rules[i].source || "uttered";
          collected.push({
            requirement_id: req.requirement_id,
            label: req.label,
            value: rules[i].value,
            value_state: "known",
            coverage: rules[i].coverage || "full",
            source_type: source,
            confidence: confidence.confidenceFor(source),
            evidence_ref: {
              input_id: inputId || null,
              start: hit.start,
              end: hit.end,
              matched_text: t.slice(hit.start, hit.end)
            }
          });
          return; // 첫 매칭 규칙 우선
        }
      }
    });
    return collected;
  }

  /** requirement_id → coverage ("covered" | "partial" | "uncovered") */
  function coverageOf(collectedItem) {
    if (!collectedItem) return "uncovered";
    if (collectedItem.value_state === "known") {
      return collectedItem.coverage === "partial" ? "partial" : "covered";
    }
    // unknown/skipped 는 명시적 미확보(재질문 안 함), pending 은 확보 대기
    return "uncovered";
  }

  /**
   * Information Gap 분석: 필요 − 확보 = Gap (FR-07)
   * @returns {{rows: Array, gap: Array, sufficiency: number}}
   *  rows: [{requirement_id, label, coverage, obtainability, ask_policy, item}]
   *  sufficiency: 고객 확보 가능 요건(획득가능성 '하' 제외) 기준 0~1
   */
  function analyze(schema, scenario, collected) {
    var byReq = {};
    (collected || []).forEach(function (c) { byReq[c.requirement_id] = c; });
    var rows = scenarioRequirements(schema, scenario).map(function (req) {
      var item = byReq[req.requirement_id] || null;
      return {
        requirement_id: req.requirement_id,
        label: req.label,
        obtainability: req.obtainability,
        ask_policy: req.ask_policy,
        coverage: coverageOf(item),
        item: item
      };
    });
    var gap = rows.filter(function (r) { return r.coverage !== "covered"; });

    // 정보충분도: 계측 필요 항목(획득가능성 '하')은 전문가 확인 몫이므로 분모에서 제외
    var scored = rows.filter(function (r) { return r.obtainability !== "하"; });
    var pts = 0;
    scored.forEach(function (r) {
      if (r.coverage === "covered") pts += 1;
      else if (r.coverage === "partial") pts += 0.5;
    });
    var sufficiency = scored.length ? pts / scored.length : 0;

    return { rows: rows, gap: gap, sufficiency: sufficiency };
  }

  return {
    pickScenario: pickScenario,
    scenarioRequirements: scenarioRequirements,
    extract: extract,
    analyze: analyze,
    coverageOf: coverageOf
  };
});
