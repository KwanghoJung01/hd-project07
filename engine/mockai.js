/**
 * mockai.js — LLM 어댑터 인터페이스 + Mock AI Rule Engine (Phase 1)
 *
 * Phase 1은 외부 AI/LLM API를 호출하지 않는다(원문 16장).
 * 아래 LLMAdapter 인터페이스만 유지하면 Phase 2에서 Local LLM 구현체로 교체할 수 있다.
 *
 *   LLMAdapter (인터페이스)
 *   ├─ analyzeIssue(ctx)            → AIAnalysis (A/B/C/D 판정, 유사사례, 근거, 한계) — FR-12/13
 *   ├─ draftStructuredOpinion(text) → 전문가 자유 서술 → 4필드 초안 (키워드→코드 매핑 템플릿) — FR-17, DP-6
 *   └─ rewriteForCustomer(text)     → 기술 언어 → 고객 언어 변환 (치환 템플릿) — FR-20
 *
 * UMD 모듈: 브라우저 window.FI.mockai / Node require 양쪽 지원.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.FI = root.FI || {};
    root.FI.mockai = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var VERDICT_LABELS = {
    A: "근거 충분 — 판단 가능 · 신뢰도 높음",
    B: "유사 사례 존재 — 동일 여부는 전문가 확인 필요",
    C: "관련 자료 없음 — 관련 표준 또는 유사 사례를 찾지 못했습니다",
    D: "정보 부족 — 추가 필요 정보 확인 요청"
  };

  /** Mock 과거 사례 저장소 (Phase 2에서 Local Vector DB로 교체) */
  var MOCK_CASES = [
    {
      case_id: "Case #0832",
      title: "HX 시리즈 냉간 시 선회 충격",
      pattern: { work: "선회", symptom: "충격" },
      similarity: 0.87,
      resolution: "냉간 시 선회 압력 순간 상승(SW-HYD-0412) — 예열 절차 안내로 해결(고객 해결 확인)",
      verified: true
    },
    {
      case_id: "Case #0714",
      title: "선회 시작 시 미세 충격(감속기 백래시)",
      pattern: { work: "선회", symptom: "충격" },
      similarity: 0.73,
      resolution: "선회 감속기(SW-MEC-0105) 백래시 조정",
      verified: true
    }
  ];

  var MOCK_DOCUMENTS = [
    { doc_id: "Manual 4-2", title: "Service Manual 4-2 선회 계통 점검 기준", topics: ["선회", "충격", "압력"] },
    { doc_id: "Manual 9-1", title: "Service Manual 9-1 경고등 코드표", topics: ["경고등", "알람"] }
  ];

  /** 전문가 서술 키워드 → 부품 코드 매핑 템플릿 (parts.master.json 코드만 산출) */
  var PART_RULES = [
    { require: ["선회"], anyOf: ["릴리프", "선회 압력", "압력 상승", "압력이 순간"], part_code: "SW-HYD-0412" },
    { require: ["선회", "모터"], anyOf: [], part_code: "SW-HYD-0201" },
    { require: ["선회"], anyOf: ["감속기", "백래시"], part_code: "SW-MEC-0105" },
    { require: ["붐"], anyOf: ["실린더"], part_code: "HYD-AT-0301" },
    { require: ["주행"], anyOf: ["모터"], part_code: "TR-DRV-0101" },
    { require: [], anyOf: ["메인 펌프", "유압 펌프"], part_code: "HYD-MN-0101" },
    { require: [], anyOf: ["컨트롤 밸브"], part_code: "HYD-MN-0205" },
    { require: [], anyOf: ["유압 필터", "오일 필터"], part_code: "HYD-MN-0401" },
    { require: [], anyOf: ["라디에이터", "냉각수"], part_code: "EN-AUX-0201" },
    { require: [], anyOf: ["배터리"], part_code: "EL-PW-0101" },
    { require: [], anyOf: ["압력 센서"], part_code: "EL-CT-0205" },
    { require: [], anyOf: ["경고등 회로", "램프 회로"], part_code: "EL-PW-0402" }
  ];

  /** 조치 유형 판별 규칙 (순서 중요) */
  var ACTION_TYPE_RULES = [
    { type: "부품교체", pattern: /교체|갈아\s*끼/ },
    { type: "조정", pattern: /조정|세팅|재설정/ },
    { type: "안내", pattern: /안내|설명드리|예열 후|절차를 알려/ },
    { type: "점검", pattern: /점검|확인/ }
  ];

  /** 기술 언어 → 고객 언어 치환 템플릿 (FR-20) */
  var CUSTOMER_TERMS = [
    ["유압 오일 온도가 낮은 상태", "장비가 충분히 예열되지 않은 상태"],
    ["선회 압력이 순간적으로 상승해서 발생하는 현상으로 판단됩니다", "오른쪽으로 회전할 때 순간적으로 충격이 발생할 가능성이 있습니다"],
    ["선회 압력이 순간적으로 상승", "회전할 때 순간적으로 충격이 발생"],
    ["릴리프 밸브", "압력 조절 장치"],
    ["냉간 시", "장비가 차가운 상태에서"],
    ["온간 시", "장비가 데워진 상태에서"],
    ["미재현 시 정상 판정", "같은 현상이 나타나지 않으면 정상"],
    ["재현 확인", "같은 현상이 발생하는지 확인"],
    ["백래시", "기어 유격"]
  ];

  function valueOf(collected, reqId) {
    var found = (collected || []).filter(function (c) {
      return c.requirement_id === reqId && c.value_state === "known";
    })[0];
    return found ? String(found.value) : null;
  }

  function createMockAdapter(partsMaster) {
    var partsByCode = {};
    var systemsByCode = {};
    ((partsMaster && partsMaster.parts) || []).forEach(function (p) { partsByCode[p.part_code] = p; });
    ((partsMaster && partsMaster.systems) || []).forEach(function (s) { systemsByCode[s.system_code] = s; });

    /**
     * AI 1차 분석 (FR-12/13, 원문 6.1 A/B/C/D 4상태)
     * @param {Object} ctx {collected, sufficiency(0~1), expertChecks[], equipment}
     */
    function analyzeIssue(ctx) {
      ctx = ctx || {}; // 컨텍스트 미전달 가드 — sufficiency 0 → D(정보 부족) 판정으로 수렴
      var collected = ctx.collected || [];
      var sufficiency = typeof ctx.sufficiency === "number" ? ctx.sufficiency : 0;
      var checks = ctx.expertChecks || [];
      var missingMeasure = checks.map(function (c) { return c.label; });

      var symptom = valueOf(collected, "MNT-01");
      var work = valueOf(collected, "MNT-02");
      var cond = valueOf(collected, "MNT-03") || "";
      var warmup = valueOf(collected, "MNT-05");
      var lamp = valueOf(collected, "MNT-09");

      // D. 정보 부족 — 정보충분도 50% 미만이면 분석보다 추가 확보가 우선
      if (sufficiency < 0.5) {
        return {
          verdict: "D",
          verdict_label: VERDICT_LABELS.D,
          similar_cases: [],
          related_documents: [],
          evidence: [],
          recommendation: "확보된 정보가 부족하여 1차 판단을 내릴 수 없습니다. 아래 항목을 고객에게 추가 확인해 주세요.",
          missing_info: ["재현성", "예열 상태", "발생 조건"].concat(missingMeasure),
          confidence: 0.2,
          limitations: "정보충분도 " + Math.round(sufficiency * 100) + "% — 근거 없는 답변을 생성하지 않습니다(DP-5)."
        };
      }

      // A. 근거 충분 — 경고등 점등은 코드표 직결
      if (symptom === "경고등" || lamp === "있음(촬영)") {
        return {
          verdict: "A",
          verdict_label: VERDICT_LABELS.A,
          similar_cases: [],
          related_documents: [MOCK_DOCUMENTS[1]],
          evidence: ["경고등/알람 코드로 원인 계통 직접 식별 가능"],
          recommendation: "경고등 코드를 Manual 9-1 코드표와 대조하여 해당 계통을 점검하십시오.",
          missing_info: [],
          confidence: 0.9,
          limitations: "코드 미확인 시 촬영 이미지를 요청하십시오."
        };
      }

      // B. 유사 사례 존재 — 선회 + 충격 패턴
      var isSwing = work === "선회" || cond.indexOf("선회") >= 0 || cond.indexOf("붐") >= 0;
      if (isSwing && symptom === "충격") {
        var cases = MOCK_CASES.filter(function (c) {
          return c.pattern.work === "선회" && c.pattern.symptom === "충격";
        });
        var lim = missingMeasure.length
          ? missingMeasure.join("·") + " 미확보로 동일 원인 단정 불가"
          : "계측값 확보 후 동일 여부 확인 필요";
        return {
          verdict: "B",
          verdict_label: VERDICT_LABELS.B,
          similar_cases: cases,
          related_documents: [MOCK_DOCUMENTS[0]],
          evidence: [
            "발생 조건(" + cond + ") · 현상(" + symptom + ")이 Case #0832 패턴과 일치",
            warmup === "시동 직후" ? "냉간(시동 직후) 발생 — 유온 연관 가능성" : "예열 상태 참고"
          ],
          recommendation: "냉간 시 선회 릴리프 압력 순간 상승 가능성이 높습니다. 예열 후 재현 확인을 권장합니다.",
          missing_info: missingMeasure,
          confidence: 0.7,
          limitations: "한계: " + lim + ". 유사도 " + Math.round(cases[0].similarity * 100) + "%는 동일 원인을 보장하지 않습니다."
        };
      }

      // C. 관련 자료 없음 — 모른다고 말한다(DP-5)
      return {
        verdict: "C",
        verdict_label: VERDICT_LABELS.C,
        similar_cases: [],
        related_documents: [],
        evidence: [],
        recommendation: "관련 표준 또는 유사 사례를 찾지 못했습니다. 전문가 판단 후 신규 사례로 등록해 주세요.",
        missing_info: [],
        confidence: 0.3,
        limitations: "Mock Knowledge 저장소에 일치 패턴이 없습니다."
      };
    }

    /**
     * 전문가 자유 서술 → 4필드 초안 (FR-17, DP-6)
     * 키워드→계통/부품 코드 매핑 + 문장 분류 템플릿.
     */
    function draftStructuredOpinion(freeText) {
      var t = (freeText == null ? "" : String(freeText)).trim();

      // 빈 입력 가드: 예외 대신 '미확정 빈 초안'을 돌려준다 (DP-5 — 근거 없는 값을 만들지 않는다)
      if (!t) {
        return {
          cause_system_code: null, cause_system_label: null,
          cause_part_code: null, cause_part_label: null,
          cause_undetermined: true,
          action_type: null, action_detail: "", rationale_text: "", prevention: "",
          note: "자유 서술이 비어 있어 초안을 생성하지 못했습니다. 서술을 입력한 뒤 다시 시도하세요."
        };
      }

      // 1) 부품/계통 코드 매핑
      var partCode = null;
      for (var i = 0; i < PART_RULES.length; i++) {
        var rule = PART_RULES[i];
        var okReq = rule.require.every(function (k) { return t.indexOf(k) >= 0; });
        var okAny = rule.anyOf.length === 0 || rule.anyOf.some(function (k) { return t.indexOf(k) >= 0; });
        if (okReq && okAny) { partCode = rule.part_code; break; }
      }
      var part = partCode ? partsByCode[partCode] : null;
      var system = part ? systemsByCode[part.system_code] : null;

      // 2) 조치 유형
      var actionType = null;
      for (var j = 0; j < ACTION_TYPE_RULES.length; j++) {
        if (ACTION_TYPE_RULES[j].pattern.test(t)) { actionType = ACTION_TYPE_RULES[j].type; break; }
      }

      // 3) 문장 분류 (판단근거 / 조치 / 재발방지)
      var sentences = t.split(/(?<=[.。!?])\s+|(?<=다)\.\s*/).map(function (s) {
        return s.replace(/\.$/, "").trim();
      }).filter(Boolean);

      var rationale = null, action = null, prevention = null;
      sentences.forEach(function (s) {
        if (!prevention && /예방|절차|주기적|동절기/.test(s) && /안내|교육|권장/.test(s)) { prevention = s; return; }
        if (!rationale && /판단|원인|추정|때문/.test(s)) { rationale = s; return; }
        if (!action && /확인|판정|조치|교체|조정|안내/.test(s)) { action = s; return; }
      });

      return {
        cause_system_code: system ? system.system_code : null,
        cause_system_label: system ? system.label : null,
        cause_part_code: part ? part.part_code : null,
        cause_part_label: part ? part.label : null,
        cause_undetermined: !part,
        action_type: actionType,
        action_detail: action || "",
        rationale_text: rationale || "",
        prevention: prevention || "",
        note: part ? null : "매핑 가능한 부품 코드를 찾지 못했습니다. 코드 마스터에서 직접 검색·선택하거나 '원인 미확정'으로 종결하세요."
      };
    }

    /**
     * 기술 언어 → 고객 언어 변환 (FR-20)
     * 치환 템플릿 + 예열 안내/후속 요청 문장 부착. 전문가 원본은 덮어쓰지 않는다(별도 CustomerResponse 저장).
     */
    function rewriteForCustomer(technicalText) {
      var t = (technicalText == null ? "" : String(technicalText)).trim();
      if (!t) return ""; // 빈 입력 가드: 안내 문구만 붙은 무의미한 회신문을 만들지 않는다
      var out = t;
      CUSTOMER_TERMS.forEach(function (pair) {
        out = out.split(pair[0]).join(pair[1]);
      });
      if (!/가능성이 있습니다|입니다|됩니다|주세요/.test(out)) out += " 상태로 확인되었습니다.";
      if (/예열/.test(t) || /예열되지 않은/.test(out)) {
        out += " 장비를 충분히 예열한 후 같은 작업을 다시 해보시고, 같은 현상이 발생하는지 먼저 확인해 주세요.";
      }
      out += " 동일한 현상이 계속되면 다시 알려주세요.";
      return out.replace(/\s+/g, " ").trim();
    }

    return {
      name: "MockRuleEngine",
      analyzeIssue: analyzeIssue,
      draftStructuredOpinion: draftStructuredOpinion,
      rewriteForCustomer: rewriteForCustomer
    };
  }

  return {
    VERDICT_LABELS: VERDICT_LABELS,
    MOCK_CASES: MOCK_CASES,
    MOCK_DOCUMENTS: MOCK_DOCUMENTS,
    createMockAdapter: createMockAdapter
  };
});
