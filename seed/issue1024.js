/**
 * seed/issue1024.js — 원문 15장 End-to-End 시나리오 시드 (ISSUE #1024)
 *
 * "붐을 내리고 오른쪽으로 돌면 가끔 덜컹거립니다." (굴착기 HX220A · SN 3421 · 3,410h)
 * 질문 3개(재현성=가끔 / 예열=시동 직후 / 정비이력=없음) 답변과
 * 저신뢰 항목(빈도) 고객 확인까지 끝난 상태를 IN_REVIEW 로 재현한다.
 * → 시드 로드 직후 전문가 흐름(E-01~05: AI 분석 B판정 · Case #0832 87% · Manual 4-2 ·
 *    SW-HYD-0412 결론 · 고객용 재작성 승인)을 바로 데모할 수 있다.
 *
 * 데이터는 손으로 박제하지 않고 엔진(gap/question/confidence/statemachine)으로 생성한다
 * — 엔진과 시드가 어긋나지 않게 하기 위함이다.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.FI_SEED = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var SEED_TEXT = "붐을 내리고 오른쪽으로 돌면 가끔 덜컹거립니다.";
  var SEED_NO = 1024;
  var EQUIPMENT = { model: "HX220A", sn: "3421", hours: 3410 };
  var ANSWERS = {
    "MNT-04": "가끔",        // "이 현상은 언제 발생하나요?"
    "MNT-05": "시동 직후",   // "시동 직후에도 발생하나요?"
    "MNT-08": "없음"         // "최근 1개월 내 정비 이력이 있나요?"
  };

  /**
   * @param {Object} db  {issues:[], knowledge:[], next_no}
   * @param {Object} ctx {schema: FI_SCHEMA, engine: FI, adapter}
   * @returns {number} 생성(또는 기존)된 issue_id
   */
  function load(db, ctx) {
    var exists = db.issues.filter(function (i) { return i.issue_id === SEED_NO; })[0];
    if (exists) return SEED_NO; // 멱등: 이미 로드됨

    var S = ctx.schema;
    var E = ctx.engine;
    var MNT = S.maintenance;

    var hoursAgo = function (h) { return new Date(Date.now() - h * 3600000).toISOString(); };
    var t0 = hoursAgo(4); // E-01 목업의 "⏱ 4시간 경과" 재현
    var inputId = "input-1024-1";

    // ① Intent 분류 + 시나리오 + 추출 (Step 1~2)
    var intentResult = E.intent.classify(SEED_TEXT, S.domains);
    var scenario = E.gap.pickScenario(SEED_TEXT, MNT);
    var collected = E.gap.extract(SEED_TEXT, MNT, scenario, inputId);

    // MNT-12 장비 식별 — 시스템 자동 획득 (QR/보유장비, 질문 예산 미소모)
    collected.push({
      requirement_id: "MNT-12", label: "장비 식별(모델/SN/가동시간)",
      value: "HX220A · SN 3421 · 3,410h", value_state: "known", coverage: "full",
      source_type: "system", confidence: E.confidence.confidenceFor("system"),
      evidence_ref: { input_id: null, type: "system", detail: "보유장비 선택" }
    });

    // ② 질문 3개 생성 + 답변 (Step 3: 재현성·예열·정비이력)
    var questions = E.question.generateQuestions(MNT, scenario, collected);
    questions.forEach(function (q) {
      var ans = ANSWERS[q.requirement_id];
      q.answer = ans;
      q.answered_at = t0;
      var idx = -1;
      collected.forEach(function (c, i) { if (c.requirement_id === q.requirement_id) idx = i; });
      var item = {
        requirement_id: q.requirement_id, label: q.label, value: ans,
        value_state: "known", coverage: "full",
        source_type: "answered", confidence: E.confidence.confidenceFor("answered"),
        evidence_ref: { input_id: null, type: "answer", question_id: q.question_id }
      };
      if (idx >= 0) collected[idx] = item; else collected.push(item);
    });

    // ③ 선택적 확인 (Step 4): 빈도(confidence 0.6)만 강조 → 고객 [맞아요]
    collected.forEach(function (c) {
      if (c.requirement_id === "MNT-06") {
        c.source_type = "answered";
        c.confidence = E.confidence.confidenceFor("answered");
        c.confirmed = true;
        c.coverage = "full";
      }
    });

    // ④ Issue 생성 → SUBMITTED → ASSIGNED → IN_REVIEW (Step 4~5)
    var issue = {
      issue_id: SEED_NO,
      status: "DRAFT",
      title: "붐 하강 + 우선회 시 충격",
      domain: intentResult.domain,
      intent: intentResult.intent,
      scenario_id: scenario.scenario_id,
      safety_level: "일반",
      priority: "보통",
      equipment_ref: EQUIPMENT,
      assignee_id: "expert-demo",
      linked_issues: [],
      user_input: {
        input_id: inputId, input_type: "text",
        original_text: SEED_TEXT, created_at: t0,
        metadata: { model: EQUIPMENT.model, sn: EQUIPMENT.sn, hours: EQUIPMENT.hours }
      },
      intent_result: intentResult,
      collected: collected,
      questions: questions,
      expert_checks: E.question.expertCheckItems(MNT, scenario, collected),
      ai_analysis: null,
      expert_opinion: null,
      customer_response: null,
      feedback: [],
      reopen_count: 0,
      pending_request: null,
      notifications: [
        { ts: t0, text: "접수되었습니다 (#1024) · 예상 회신 24시간" },
        { ts: hoursAgo(3.9), text: "담당 전문가가 확인 중입니다" }
      ],
      audit: [],
      knowledge_entry: null,
      created_at: t0
    };
    E.statemachine.appendAudit(issue, "issue_created",
      { domain: issue.domain, scenario: issue.scenario_id, seed: true }, "접수자");
    E.statemachine.transition(issue, "SUBMITTED", { actor: "접수자", note: "사용자 접수(시드)" });
    E.statemachine.transition(issue, "ASSIGNED", { actor: "system", note: "자동 배정: 전문가 데모 계정" });
    E.statemachine.transition(issue, "IN_REVIEW", { actor: "전문가", note: "검토 시작" });

    db.issues.push(issue);
    if (db.next_no <= SEED_NO) db.next_no = SEED_NO + 1;
    return SEED_NO;
  }

  return {
    SEED_TEXT: SEED_TEXT,
    SEED_NO: SEED_NO,
    EQUIPMENT: EQUIPMENT,
    ANSWERS: ANSWERS,
    load: load
  };
});
