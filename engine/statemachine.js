/**
 * statemachine.js — Issue 상태 머신 (원문 5장) + Append-only 감사 이력 (FR-25)
 *
 * DRAFT → SUBMITTED → ASSIGNED → IN_REVIEW ⇄ PENDING_FIELD
 * IN_REVIEW → ANSWERED → RESOLVED / REOPENED(→IN_REVIEW)
 * RESOLVED → KNOWLEDGE_READY
 * 어느 단계에서든 → MERGED / STALE / CLOSED_UNVERIFIED (종결은 상태이지 삭제가 아니다, DP-9)
 *
 * 불법 전이는 Error 를 던진다.
 * UMD 모듈: 브라우저 window.FI.statemachine / Node require 양쪽 지원.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.FI = root.FI || {};
    root.FI.statemachine = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var STATES = [
    "DRAFT", "SUBMITTED", "ASSIGNED", "IN_REVIEW", "PENDING_FIELD",
    "ANSWERED", "RESOLVED", "REOPENED", "KNOWLEDGE_READY",
    "MERGED", "STALE", "CLOSED_UNVERIFIED"
  ];

  /** 정규 전이표 */
  var TRANSITIONS = {
    DRAFT: ["SUBMITTED"],
    SUBMITTED: ["ASSIGNED"],
    ASSIGNED: ["IN_REVIEW"],
    IN_REVIEW: ["PENDING_FIELD", "ANSWERED"],
    PENDING_FIELD: ["IN_REVIEW"],
    ANSWERED: ["RESOLVED", "REOPENED"],
    RESOLVED: ["KNOWLEDGE_READY"],
    REOPENED: ["IN_REVIEW"],
    KNOWLEDGE_READY: [],
    MERGED: [],
    STALE: [],
    CLOSED_UNVERIFIED: []
  };

  /** 어느 단계에서든 진입 가능한 보류/종결 상태 */
  var GLOBAL_TARGETS = ["MERGED", "STALE", "CLOSED_UNVERIFIED"];

  var LABELS = {
    DRAFT: "작성 중",
    SUBMITTED: "접수됨",
    ASSIGNED: "배정됨",
    IN_REVIEW: "검토 중",
    PENDING_FIELD: "현장 확인 대기",
    ANSWERED: "답변 완료",
    RESOLVED: "해결됨",
    REOPENED: "재검토 요청",
    KNOWLEDGE_READY: "지식 승격 후보",
    MERGED: "유사 이슈 병합",
    STALE: "무응답 보류",
    CLOSED_UNVERIFIED: "미검증 종결"
  };

  function isState(s) { return STATES.indexOf(s) >= 0; }

  function canTransition(from, to) {
    if (!isState(from) || !isState(to)) return false;
    if (GLOBAL_TARGETS.indexOf(to) >= 0 && GLOBAL_TARGETS.indexOf(from) < 0) return true;
    return (TRANSITIONS[from] || []).indexOf(to) >= 0;
  }

  /** 감사 이력 추가 (FR-25: append-only) */
  function appendAudit(issue, event, detail, actor) {
    if (!issue.audit) issue.audit = [];
    issue.audit.push({
      seq: issue.audit.length + 1,
      ts: new Date().toISOString(),
      actor: actor || "system",
      event: event,
      detail: detail || null
    });
    return issue;
  }

  /**
   * 상태 전이 실행. 불법 전이는 throw.
   * @param {Object} issue Issue 객체({status, audit[]})
   * @param {string} to 목표 상태
   * @param {Object} [meta] {actor, note}
   */
  function transition(issue, to, meta) {
    var from = issue.status;
    if (!canTransition(from, to)) {
      throw new Error("불법 상태 전이: " + from + " → " + to);
    }
    issue.status = to;
    appendAudit(issue, "status_change",
      { from: from, to: to, note: (meta && meta.note) || null },
      meta && meta.actor);
    return issue;
  }

  return {
    STATES: STATES,
    TRANSITIONS: TRANSITIONS,
    GLOBAL_TARGETS: GLOBAL_TARGETS,
    LABELS: LABELS,
    canTransition: canTransition,
    transition: transition,
    appendAudit: appendAudit
  };
});
