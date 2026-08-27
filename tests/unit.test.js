/**
 * 단위 테스트 — 실행: node tests/unit.test.js
 *
 * 대상: DecisionImpact 계산(수기 검증), confidence 출처 테이블, 상태머신 전이/불법 전이,
 *       Intent/안전 감지, Gap 분석(15장 시나리오 원문), 질문 3개 제한·획득가능성 '하' 제외,
 *       Mock AI(A/B/C/D, 4필드 초안, 고객 언어 변환), 스키마 번들 동기화.
 */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
const readJSON = (p) => JSON.parse(fs.readFileSync(path.join(root, p), "utf8"));

const domainsSchema = readJSON("schema/domains.json");
const mntSchema = readJSON("schema/maintenance.requirements.json");
const partsMaster = readJSON("schema/parts.master.json");
const undetermined = readJSON("schema/undetermined_reasons.json");

const confidence = require("../engine/confidence.js");
const intent = require("../engine/intent.js");
const gap = require("../engine/gap.js");
const question = require("../engine/question.js");
const sm = require("../engine/statemachine.js");
const mockai = require("../engine/mockai.js");

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ✔ " + name);
  } catch (e) {
    failed++;
    console.error("  ✘ " + name);
    console.error("    " + (e && e.message));
  }
}

const SEED_TEXT = "붐을 내리고 오른쪽으로 돌면 가끔 덜컹거립니다.";
const reqById = {};
mntSchema.requirements.forEach((r) => { reqById[r.requirement_id] = r; });

console.log("\n[1] DecisionImpact = 판별력 × 획득가능성 × 미확보도 (수기 검증)");
test("MNT-04 재현성(5, 상, 미확보) = 5 × 1.0 × 1 = 5.0", () => {
  assert.strictEqual(question.decisionImpact(reqById["MNT-04"], "uncovered", mntSchema), 5.0);
});
test("MNT-07 RPM(4, 중, 미확보) = 4 × 0.6 × 1 = 2.4", () => {
  assert.ok(Math.abs(question.decisionImpact(reqById["MNT-07"], "uncovered", mntSchema) - 2.4) < 1e-9);
});
test("MNT-06 빈도(3, 상, 부분 확보) = 3 × 1.0 × 0.5 = 1.5", () => {
  assert.strictEqual(question.decisionImpact(reqById["MNT-06"], "partial", mntSchema), 1.5);
});
test("MNT-10 유압 온도(3, 하, 미확보) = 3 × 0.1 × 1 = 0.3", () => {
  assert.ok(Math.abs(question.decisionImpact(reqById["MNT-10"], "uncovered", mntSchema) - 0.3) < 1e-9);
});
test("MNT-12 장비 식별(5, 자동) = 5 × 0 × 1 = 0 (질문 예산 미소모)", () => {
  assert.strictEqual(question.decisionImpact(reqById["MNT-12"], "uncovered", mntSchema), 0);
});
test("확보 완료 항목의 미확보도 = 0 → impact 0", () => {
  assert.strictEqual(question.decisionImpact(reqById["MNT-04"], "covered", mntSchema), 0);
});

console.log("\n[2] 출처 기반 confidence 테이블 (원문 9.2 그대로)");
test("uttered 0.95 / answered 0.99 / system 1.0 / inferred 0.6 / default 0.4 / ambiguous 0.5", () => {
  assert.strictEqual(confidence.confidenceFor("uttered"), 0.95);
  assert.strictEqual(confidence.confidenceFor("answered"), 0.99);
  assert.strictEqual(confidence.confidenceFor("system"), 1.0);
  assert.strictEqual(confidence.confidenceFor("inferred"), 0.6);
  assert.strictEqual(confidence.confidenceFor("default"), 0.4);
  assert.strictEqual(confidence.confidenceFor("ambiguous"), 0.5);
});
test("confidence < 0.7 필드만, 판단영향도 순 상위 2개만 확인 대상(DP-4)", () => {
  const collected = [
    { requirement_id: "MNT-01", value_state: "known", confidence: 0.95 }, // 확인 제외
    { requirement_id: "MNT-06", value_state: "known", confidence: 0.6 },  // 3.0
    { requirement_id: "MNT-08", value_state: "known", confidence: 0.4 },  // 2.4
    { requirement_id: "MNT-03", value_state: "known", confidence: 0.5 },  // 5.0
    { requirement_id: "MNT-07", value_state: "unknown", confidence: 0.6 } // known 아님 → 제외
  ];
  const targets = confidence.confirmTargets(collected, mntSchema);
  assert.strictEqual(targets.length, 2);
  assert.deepStrictEqual(targets.map((t) => t.requirement_id), ["MNT-03", "MNT-06"]);
});

console.log("\n[3] Issue 상태머신 — 정상 루프와 불법 전이");
test("전체 루프 1회전: DRAFT→…→RESOLVED→KNOWLEDGE_READY", () => {
  const issue = { status: "DRAFT", audit: [] };
  ["SUBMITTED", "ASSIGNED", "IN_REVIEW", "PENDING_FIELD", "IN_REVIEW", "ANSWERED", "RESOLVED", "KNOWLEDGE_READY"]
    .forEach((s) => sm.transition(issue, s, { actor: "test" }));
  assert.strictEqual(issue.status, "KNOWLEDGE_READY");
  assert.strictEqual(issue.audit.length, 8); // FR-25 append-only
  assert.strictEqual(issue.audit[0].detail.from, "DRAFT");
});
test("REOPEN 루프: ANSWERED→REOPENED→IN_REVIEW", () => {
  const issue = { status: "ANSWERED", audit: [] };
  sm.transition(issue, "REOPENED");
  sm.transition(issue, "IN_REVIEW");
  assert.strictEqual(issue.status, "IN_REVIEW");
});
test("불법 전이는 throw: DRAFT→ANSWERED, RESOLVED→REOPENED, SUBMITTED→IN_REVIEW", () => {
  assert.throws(() => sm.transition({ status: "DRAFT", audit: [] }, "ANSWERED"), /불법 상태 전이/);
  assert.throws(() => sm.transition({ status: "RESOLVED", audit: [] }, "REOPENED"), /불법 상태 전이/);
  assert.throws(() => sm.transition({ status: "SUBMITTED", audit: [] }, "IN_REVIEW"), /불법 상태 전이/);
});
test("어느 단계에서든 MERGED/STALE/CLOSED_UNVERIFIED 진입 가능(DP-9)", () => {
  ["DRAFT", "IN_REVIEW", "ANSWERED", "PENDING_FIELD"].forEach((from) => {
    ["MERGED", "STALE", "CLOSED_UNVERIFIED"].forEach((to) => {
      assert.ok(sm.canTransition(from, to), from + "→" + to);
    });
  });
  assert.ok(!sm.canTransition("MERGED", "STALE"));
});

console.log("\n[4] Intent 분류 + 안전 위험 감지 (FR-04/05)");
test("시나리오 원문 → 정비 도메인 / abnormal_symptom", () => {
  const r = intent.classify(SEED_TEXT, domainsSchema);
  assert.strictEqual(r.domain, "maintenance");
  assert.strictEqual(r.intent, "abnormal_symptom");
  assert.strictEqual(r.safety_flag, false);
});
test("경고등 문구 → warning_lamp Intent", () => {
  const r = intent.classify("주행 중에 경고등이 켜졌어요", domainsSchema);
  assert.strictEqual(r.domain, "maintenance");
  assert.strictEqual(r.intent, "warning_lamp");
});
test("안전 위험 키워드(연기/브레이크 안 들음) → safety_flag=true", () => {
  const r = intent.classify("엔진룸에서 연기가 나고 브레이크가 안 들어요", domainsSchema);
  assert.strictEqual(r.safety_flag, true);
  assert.ok(r.safety_hits.length >= 2);
});
test("매칭 없는 입력 → 기타(etc)", () => {
  const r = intent.classify("안녕하세요", domainsSchema);
  assert.strictEqual(r.domain, "etc");
});

console.log("\n[5] Gap 분석 — 15장 Step 2 재현");
test("시나리오 선택: 기본=이상 현상(MNT-S01), 경고등 입력=MNT-S02 (동적 정보요건)", () => {
  assert.strictEqual(gap.pickScenario(SEED_TEXT, mntSchema).scenario_id, "MNT-S01");
  assert.strictEqual(gap.pickScenario("경고등이 켜졌어요", mntSchema).scenario_id, "MNT-S02");
});
const scenario = gap.pickScenario(SEED_TEXT, mntSchema);
const extracted = gap.extract(SEED_TEXT, mntSchema, scenario, "input-1");
test("확보: 현상=충격 ✓, 작업=선회 ✓, 조건=붐 하강+우선회 ✓, 빈도=△(부분)", () => {
  const byId = {};
  extracted.forEach((c) => { byId[c.requirement_id] = c; });
  assert.strictEqual(byId["MNT-01"].value, "충격");
  assert.strictEqual(byId["MNT-02"].value, "선회");
  assert.strictEqual(byId["MNT-03"].value, "붐 하강 + 우선회");
  assert.strictEqual(byId["MNT-06"].coverage, "partial");
  assert.strictEqual(byId["MNT-06"].source_type, "inferred");
  assert.strictEqual(byId["MNT-06"].confidence, 0.6);
  assert.ok(!byId["MNT-04"] && !byId["MNT-05"] && !byId["MNT-08"], "재현성/예열/정비이력은 미확보");
});
test("evidence_ref: input_id + 원문 char offset(DP-2)", () => {
  extracted.forEach((c) => {
    assert.strictEqual(c.evidence_ref.input_id, "input-1");
    assert.strictEqual(SEED_TEXT.slice(c.evidence_ref.start, c.evidence_ref.end), c.evidence_ref.matched_text);
  });
  const symptom = extracted.filter((c) => c.requirement_id === "MNT-01")[0];
  assert.strictEqual(symptom.evidence_ref.matched_text, "덜컹");
});
test("Gap = 필요 − 확보, 정보충분도 계산", () => {
  const g = gap.analyze(mntSchema, scenario, extracted);
  const gapIds = g.gap.map((r) => r.requirement_id);
  ["MNT-04", "MNT-05", "MNT-06", "MNT-07", "MNT-08", "MNT-10", "MNT-11", "MNT-12"].forEach((id) => {
    assert.ok(gapIds.indexOf(id) >= 0, id + " 은 Gap");
  });
  assert.ok(g.sufficiency > 0 && g.sufficiency < 1);
});

console.log("\n[6] Question Engine — 3개 제한 · '하' 제외 · [모르겠음] (P1~P5)");
const questions = question.generateQuestions(mntSchema, scenario, extracted);
test("상위 3개 = 재현성 · 예열 상태 · 최근 정비 이력 (Step 2와 동일)", () => {
  assert.strictEqual(questions.length, 3);
  assert.deepStrictEqual(questions.map((q) => q.requirement_id), ["MNT-04", "MNT-05", "MNT-08"]);
});
test("모든 질문에 [모르겠음] 포함 (P4)", () => {
  questions.forEach((q) => assert.ok(q.options.indexOf("모르겠음") >= 0, q.requirement_id));
});
test("획득가능성 '하'(MNT-10/11)와 자동(MNT-12)은 절대 질문하지 않음 (P5)", () => {
  const all = question.generateQuestions(mntSchema, scenario, [], 99);
  const ids = all.map((q) => q.requirement_id);
  assert.ok(ids.indexOf("MNT-10") < 0 && ids.indexOf("MNT-11") < 0 && ids.indexOf("MNT-12") < 0);
});
test("MNT-10/11 은 전문가 추가 확인 항목으로 반환", () => {
  const checks = question.expertCheckItems(mntSchema, scenario, extracted);
  assert.deepStrictEqual(checks.map((c) => c.requirement_id), ["MNT-10", "MNT-11"]);
  assert.deepStrictEqual(checks.map((c) => c.label), ["유압 온도", "선회 압력"]);
});
test("unknown/skipped 응답 항목은 재질문하지 않음", () => {
  const withUnknown = extracted.concat([
    { requirement_id: "MNT-04", value_state: "unknown", value: null },
    { requirement_id: "MNT-05", value_state: "skipped", value: null }
  ]);
  const qs = question.generateQuestions(mntSchema, scenario, withUnknown);
  const ids = qs.map((q) => q.requirement_id);
  assert.ok(ids.indexOf("MNT-04") < 0 && ids.indexOf("MNT-05") < 0);
});

console.log("\n[7] Mock AI — A/B/C/D 판정 · 4필드 초안 · 고객 언어 변환");
const adapter = mockai.createMockAdapter(partsMaster);
test("시나리오 이슈(선회+충격, 답변 완료) → 판정 B, Case #0832 87%, Manual 4-2", () => {
  const answered = extracted.concat([
    { requirement_id: "MNT-04", value: "가끔", value_state: "known", coverage: "full", source_type: "answered", confidence: 0.99 },
    { requirement_id: "MNT-05", value: "시동 직후", value_state: "known", coverage: "full", source_type: "answered", confidence: 0.99 },
    { requirement_id: "MNT-08", value: "없음", value_state: "known", coverage: "full", source_type: "answered", confidence: 0.99 },
    { requirement_id: "MNT-12", value: "HX220A / SN 3421 / 3,410h", value_state: "known", coverage: "full", source_type: "system", confidence: 1.0 }
  ]);
  const g = gap.analyze(mntSchema, scenario, answered);
  const checks = question.expertCheckItems(mntSchema, scenario, answered);
  const a = adapter.analyzeIssue({ collected: answered, sufficiency: g.sufficiency, expertChecks: checks });
  assert.strictEqual(a.verdict, "B");
  assert.strictEqual(a.similar_cases[0].case_id, "Case #0832");
  assert.strictEqual(a.similar_cases[0].similarity, 0.87);
  assert.strictEqual(a.related_documents[0].doc_id, "Manual 4-2");
  assert.ok(a.limitations.indexOf("유압 온도") >= 0 && a.limitations.indexOf("선회 압력") >= 0, "한계 명시");
});
test("정보충분도 낮음 → 판정 D + 추가 필요 정보 목록", () => {
  const a = adapter.analyzeIssue({ collected: [], sufficiency: 0.2, expertChecks: [] });
  assert.strictEqual(a.verdict, "D");
  assert.ok(a.missing_info.length > 0);
});
test("경고등 있음 → 판정 A / 무관 입력 → 판정 C(자료 없음 명시, DP-5)", () => {
  const a = adapter.analyzeIssue({
    collected: [{ requirement_id: "MNT-09", value: "있음(촬영)", value_state: "known" }],
    sufficiency: 0.8, expertChecks: []
  });
  assert.strictEqual(a.verdict, "A");
  const c = adapter.analyzeIssue({
    collected: [{ requirement_id: "MNT-01", value: "소음", value_state: "known" }],
    sufficiency: 0.8, expertChecks: []
  });
  assert.strictEqual(c.verdict, "C");
  assert.ok(c.recommendation.indexOf("찾지 못했습니다") >= 0);
});
test("전문가 자유 서술 → 4필드 초안 (SW-HYD-0412 매핑, 조치유형 '안내')", () => {
  const draft = adapter.draftStructuredOpinion(
    "유압 오일 온도가 낮은 상태에서 선회 압력이 순간적으로 상승해서 발생하는 현상으로 판단됩니다. " +
    "예열 후 재현 확인하고 미재현 시 정상 판정하면 됩니다. 동절기 예열 절차 안내가 필요합니다."
  );
  assert.strictEqual(draft.cause_part_code, "SW-HYD-0412");
  assert.strictEqual(draft.cause_system_code, "SW-HYD");
  assert.strictEqual(draft.cause_system_label, "선회 유압 계통");
  assert.strictEqual(draft.action_type, "안내");
  assert.ok(draft.rationale_text.indexOf("판단") >= 0);
  assert.ok(draft.action_detail.indexOf("재현 확인") >= 0);
  assert.ok(draft.prevention.indexOf("동절기") >= 0);
});
test("기술 언어 → 고객 언어 치환 템플릿 (원문 10.4 예시)", () => {
  const out = adapter.rewriteForCustomer(
    "유압 오일 온도가 낮은 상태에서 선회 압력이 순간적으로 상승해서 발생하는 현상으로 판단됩니다."
  );
  assert.ok(out.indexOf("장비가 충분히 예열되지 않은 상태") >= 0);
  assert.ok(out.indexOf("충격이 발생할 가능성") >= 0);
  assert.ok(out.indexOf("유압") < 0, "기술 용어 제거");
  assert.ok(out.indexOf("예열한 후") >= 0, "예열 안내 포함");
});

test("빈/널 입력 가드: draftStructuredOpinion → 미확정 빈 초안 (throw 없음)", () => {
  [null, undefined, "", "   "].forEach((input) => {
    const d = adapter.draftStructuredOpinion(input);
    assert.strictEqual(d.cause_part_code, null);
    assert.strictEqual(d.cause_system_code, null);
    assert.strictEqual(d.cause_undetermined, true);
    assert.strictEqual(d.action_detail, "");
    assert.strictEqual(d.rationale_text, "");
    assert.strictEqual(d.prevention, "");
    assert.ok(d.note && d.note.indexOf("비어") >= 0, "빈 입력 안내 note");
  });
});
test("빈/널 입력 가드: rewriteForCustomer → 빈 문자열 (안내 문구만 붙은 회신문 금지)", () => {
  [null, undefined, "", "  \n "].forEach((input) => {
    assert.strictEqual(adapter.rewriteForCustomer(input), "");
  });
});
test("컨텍스트 미전달 가드: analyzeIssue(null/{}) → D(정보 부족) 판정 (throw 없음)", () => {
  [null, undefined, {}].forEach((ctx) => {
    const a = adapter.analyzeIssue(ctx);
    assert.strictEqual(a.verdict, "D");
  });
});

console.log("\n[8] 스키마 무결성 + 번들 동기화");
test("MNT-01~12 12개 요건, 원문 7.2 판별력/획득가능성 일치", () => {
  assert.strictEqual(mntSchema.requirements.length, 12);
  const expect = {
    "MNT-01": [5, "상"], "MNT-02": [4, "상"], "MNT-03": [5, "상"], "MNT-04": [5, "상"],
    "MNT-05": [5, "상"], "MNT-06": [3, "상"], "MNT-07": [4, "중"], "MNT-08": [4, "중"],
    "MNT-09": [4, "상"], "MNT-10": [3, "하"], "MNT-11": [4, "하"], "MNT-12": [5, "자동"]
  };
  Object.keys(expect).forEach((id) => {
    assert.strictEqual(reqById[id].discriminative_weight, expect[id][0], id + " 판별력");
    assert.strictEqual(reqById[id].obtainability, expect[id][1], id + " 획득가능성");
  });
});
test("부품 마스터: SW-HYD-0412 선회 모터 릴리프 밸브 / 선회 유압 계통 포함, 20개 이상", () => {
  const p = partsMaster.parts.filter((x) => x.part_code === "SW-HYD-0412")[0];
  assert.ok(p && p.label === "선회 모터 릴리프 밸브");
  const s = partsMaster.systems.filter((x) => x.system_code === p.system_code)[0];
  assert.strictEqual(s.label, "선회 유압 계통");
  assert.ok(partsMaster.parts.length >= 20);
});
test("미확정 사유 코드 4종(정보부족/재현불가/고객 미회신/타 부서 이관)", () => {
  assert.deepStrictEqual(undetermined.reasons.map((r) => r.label),
    ["정보부족", "재현불가", "고객 미회신", "타 부서 이관"]);
});
test("app/schema.bundle.js 가 schema/*.json 과 동기화되어 있음", () => {
  const src = fs.readFileSync(path.join(root, "app/schema.bundle.js"), "utf8");
  const sandbox = {};
  vm.runInNewContext(src + "\n;__out = JSON.stringify(this.FI_SCHEMA);", sandbox);
  const bundle = JSON.parse(sandbox.__out); // vm 컨텍스트 간 프로토타입 차이 제거
  assert.deepStrictEqual(bundle.domains, domainsSchema);
  assert.deepStrictEqual(bundle.maintenance, mntSchema);
  assert.deepStrictEqual(bundle.parts, partsMaster);
  assert.deepStrictEqual(bundle.undetermined, undetermined);
});

/* ───────────────── 2차 고도화(음성·STT·미디어) 모듈 ───────────────── */
const media = require("../engine/media.js");
const stt = require("../engine/stt.js");
const aivision = require("../engine/aivision.js");

/** 비동기 테스트 헬퍼 — 마지막에 순서대로 실행 후 결과 집계 */
const asyncTests = [];
function atest(name, fn) { asyncTests.push({ name, fn }); }

console.log("\n[9] media — 파일 검증·용량 제한·프레임 추출·포맷");
test("유형 판별: audio/image/video, 그 외 거부", () => {
  assert.strictEqual(media.kindOf("audio/webm"), "audio");
  assert.strictEqual(media.kindOf("image/png"), "image");
  assert.strictEqual(media.kindOf("video/mp4"), "video");
  assert.strictEqual(media.kindOf("application/pdf"), null);
  assert.strictEqual(media.validateFile({ name: "a.pdf", type: "application/pdf", size: 10 }).ok, false);
});
test("영상 50MB 제한: 초과 시 명확한 안내, 이내는 통과", () => {
  const over = media.validateFile({ name: "v.mp4", type: "video/mp4", size: 50 * 1024 * 1024 + 1 });
  assert.strictEqual(over.ok, false);
  assert.ok(over.error.indexOf("용량 초과") >= 0 && over.error.indexOf("50.0MB") >= 0);
  const under = media.validateFile({ name: "v.mp4", type: "video/mp4", size: 49 * 1024 * 1024 });
  assert.deepStrictEqual(under, { ok: true, kind: "video" });
  assert.strictEqual(media.LIMITS.video, 50 * 1024 * 1024);
});
test("frameTimes: 최대 3장(10/50/90%), 짧은 영상은 중앙 1장, 잘못된 길이는 [0]", () => {
  assert.deepStrictEqual(media.frameTimes(100, 3), [10, 50, 90]);
  assert.deepStrictEqual(media.frameTimes(1.5, 3), [0.75]);
  assert.deepStrictEqual(media.frameTimes(0, 3), [0]);
  assert.deepStrictEqual(media.frameTimes(60, 1), [30]);
  assert.ok(media.frameTimes(200, 3).length <= 3);
});
test("formatBytes/formatDuration", () => {
  assert.strictEqual(media.formatBytes(52428800), "50.0MB");
  assert.strictEqual(media.formatBytes(2048), "2.0KB");
  assert.strictEqual(media.formatDuration(75), "1:15");
});

console.log("\n[10] media — transcript 세그먼트 병합·char offset 매핑(근거 점프)");
const SEGS = [
  { text: "붐을 내리고 오른쪽으로 돌면", start_ms: 0, end_ms: 2100 },
  { text: "가끔 덜컹거립니다.", start_ms: 2100, end_ms: 3900 }
];
test("buildTranscript: 세그먼트 이어붙이기 + char offset 계산", () => {
  const t = media.buildTranscript(SEGS);
  assert.strictEqual(t.text, "붐을 내리고 오른쪽으로 돌면 가끔 덜컹거립니다.");
  assert.strictEqual(t.segments[0].char_start, 0);
  assert.strictEqual(t.text.slice(t.segments[1].char_start, t.segments[1].char_end), "가끔 덜컹거립니다.");
  assert.strictEqual(t.segments[1].start_ms, 2100);
});
test("locateSegments: 사용자 편집(앞에 문구 추가) 후에도 세그먼트 위치 재탐색", () => {
  const edited = "HX220A 장비입니다. 붐을 내리고 오른쪽으로 돌면 가끔 덜컹거립니다.";
  const located = media.locateSegments(edited, SEGS);
  assert.strictEqual(edited.slice(located[0].char_start, located[0].char_end), "붐을 내리고 오른쪽으로 돌면");
  assert.strictEqual(edited.slice(located[1].char_start, located[1].char_end), "가끔 덜컹거립니다.");
  const removed = media.locateSegments("전혀 다른 텍스트", SEGS);
  assert.strictEqual(removed[0].char_start, -1, "삭제된 세그먼트는 -1 (오디오 재생만 가능)");
});
test("segmentForRange: '덜컹' char 구간 → 두 번째 세그먼트(start_ms 2100)로 매핑", () => {
  const full = "붐을 내리고 오른쪽으로 돌면 가끔 덜컹거립니다.";
  const located = media.locateSegments(full, SEGS);
  const idx = full.indexOf("덜컹");
  const seg = media.segmentForRange(located, idx, idx + 2);
  assert.ok(seg && seg.start_ms === 2100);
  assert.strictEqual(media.segmentForRange(located, 9999), null);
});

console.log("\n[11] stt — Web Speech 어댑터(주입 테스트)·Whisper 응답 파서");
test("가짜 SpeechRecognition 주입 → 녹음 기준 ms 세그먼트 기록", () => {
  let clock = 10000;
  let instance = null;
  function FakeSR() {
    instance = this;
    this.start = () => {};
    this.stop = () => { if (this.onend) this.onend(); };
  }
  const engine = stt.createWebSpeechSTT({ Impl: FakeSR, now: () => clock });
  const got = [];
  engine.onsegment = (s) => got.push(s);
  engine.start(); // t0 = 10000
  clock = 12100;
  instance.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: "붐을 내리고 오른쪽으로 돌면" }], { isFinal: true })] });
  clock = 13900;
  instance.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: "가끔 덜컹거립니다." }], { isFinal: true })] });
  let ended = null;
  engine.onend = (segs) => { ended = segs; };
  engine.stop();
  assert.deepStrictEqual(got, [
    { text: "붐을 내리고 오른쪽으로 돌면", start_ms: 0, end_ms: 2100 },
    { text: "가끔 덜컹거립니다.", start_ms: 2100, end_ms: 3900 }
  ]);
  assert.strictEqual(ended.length, 2);
});
test("interim 결과는 세그먼트로 저장하지 않고 oninterim 으로만 전달", () => {
  let instance = null;
  function FakeSR() { instance = this; this.start = () => {}; this.stop = () => {}; }
  const engine = stt.createWebSpeechSTT({ Impl: FakeSR, now: () => 0 });
  let interim = null;
  engine.oninterim = (t) => { interim = t; };
  engine.start();
  instance.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: "붐을 내" }], { isFinal: false })] });
  assert.strictEqual(interim, "붐을 내");
  assert.strictEqual(engine.segments.length, 0);
});
test("Whisper verbose_json 세그먼트 → ms 변환 / 일반 응답 → 1세그먼트", () => {
  const segs = stt.parseWhisperResponse({
    text: "전체", segments: [{ start: 0, end: 2.1, text: " 붐을 내리고 " }, { start: 2.1, end: 3.9, text: "가끔 덜컹거립니다." }]
  });
  assert.deepStrictEqual(segs[0], { text: "붐을 내리고", start_ms: 0, end_ms: 2100 });
  const single = stt.parseWhisperResponse({ text: "덜컹거립니다" }, 4000);
  assert.deepStrictEqual(single, [{ text: "덜컹거립니다", start_ms: 0, end_ms: 4000 }]);
});

console.log("\n[12] aivision — 비전 어댑터(키 없으면 비활성, fetch 주입 검증)");
test("provider/키 미설정 → 어댑터 null (기본 경로는 완전 오프라인)", () => {
  assert.strictEqual(aivision.createVisionAdapter(null), null);
  assert.strictEqual(aivision.createVisionAdapter({ provider: "none", api_key: "x" }), null);
  assert.strictEqual(aivision.createVisionAdapter({ provider: "claude", api_key: "" }), null);
});
test("parseDataURI / parseFindings(코드펜스 허용)", () => {
  const p = aivision.parseDataURI("data:image/png;base64,AAAA");
  assert.deepStrictEqual(p, { media_type: "image/png", base64: "AAAA" });
  assert.strictEqual(aivision.parseDataURI("http://x/y.png"), null);
  const f = aivision.parseFindings('```json\n{"summary":"유압 호스 누유","observed":["붐 실린더"],"hazards":[]}\n```');
  assert.strictEqual(f.summary, "유압 호스 누유");
  assert.deepStrictEqual(f.observed, ["붐 실린더"]);
});
atest("요청 형식: 이미지 base64 블록 + 버전 헤더, 응답 → media_findings 구조화", async () => {
  let captured = null;
  const fakeFetch = (url, init) => {
    captured = { url, init };
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ content: [{ text: '{"summary":"선회부 오일 비침","observed":["선회 모터"],"hazards":["누유 흔적"]}' }] })
    });
  };
  const adapter = aivision.createVisionAdapter({ provider: "claude", api_key: "test-key" }, fakeFetch);
  const out = await adapter.analyzeMedia({ images: ["data:image/png;base64,AAAA"], context: "덜컹거립니다" });
  assert.strictEqual(captured.url, "https://api.anthropic.com/v1/messages");
  assert.strictEqual(captured.init.headers["anthropic-version"], "2023-06-01");
  const body = JSON.parse(captured.init.body);
  assert.strictEqual(body.messages[0].content[0].source.data, "AAAA");
  assert.strictEqual(out.summary, "선회부 오일 비침");
  assert.deepStrictEqual(out.hazards, ["누유 흔적"]);
});
atest("OpenAI 형식: image_url data URI + json_object, 오류 응답은 예외로 전달", async () => {
  const okFetch = () => Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ choices: [{ message: { content: '{"summary":"s","observed":[],"hazards":[]}' } }] })
  });
  const adapter = aivision.createVisionAdapter({ provider: "openai", api_key: "k" }, okFetch);
  const out = await adapter.analyzeMedia({ images: ["data:image/png;base64,BBBB"] });
  assert.strictEqual(out.summary, "s");
  const failFetch = () => Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) });
  const bad = aivision.createVisionAdapter({ provider: "openai", api_key: "k" }, failFetch);
  await assert.rejects(() => bad.analyzeMedia({ images: ["data:image/png;base64,BBBB"] }), /401/);
});

/* ══════════════════════ 서버 연결층 (fi-supabase.js) ══════════════════════
   이 파일은 브라우저용 UMD 가 아니라 window 에 붙는 스크립트라
   vm 으로 가짜 window 를 만들어 읽어 들인다. */
const FIS = (() => {
  const sandbox = { self: null, window: null, FI: { statemachine: sm }, APP_CONFIG: {} };
  sandbox.self = sandbox; sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, "app/fi-supabase.js"), "utf8"), sandbox);
  return sandbox.FISupabase;
})();

// vm 안에서 만들어진 배열은 프로토타입이 달라 deepStrictEqual 이 구조가 같아도 실패한다.
// 이쪽 realm 의 배열로 옮겨 담고 비교한다.
const arr = (x) => (x == null ? x : Array.from(x));

test("상태 경로: 접수 직후 ASSIGNED 까지 한 칸씩 간다", () => {
  // 화면은 접수 한 번에 DRAFT→SUBMITTED→ASSIGNED 로 간다.
  // DB 는 한 걸음씩만 허용하므로 어댑터가 길을 펴야 한다.
  assert.deepStrictEqual(arr(FIS.pathTo("DRAFT", "ASSIGNED")), ["SUBMITTED", "ASSIGNED"]);
});

test("상태 경로: 제자리는 빈 배열", () => {
  assert.deepStrictEqual(arr(FIS.pathTo("IN_REVIEW", "IN_REVIEW")), []);
});

test("상태 경로: 종결 상태는 어디서든 한 걸음", () => {
  assert.deepStrictEqual(arr(FIS.pathTo("DRAFT", "STALE")), ["STALE"]);
});

test("상태 경로: 되돌릴 수 없는 곳은 null", () => {
  // KNOWLEDGE_READY 에서 나가는 길이 없다 — 없는 길을 억지로 만들면 안 된다
  assert.strictEqual(FIS.pathTo("KNOWLEDGE_READY", "IN_REVIEW"), null);
});

test("상태 경로: 실제 한 바퀴가 전부 이어진다", () => {
  const legs = [["DRAFT","ASSIGNED"],["ASSIGNED","IN_REVIEW"],["IN_REVIEW","ANSWERED"],
                ["ANSWERED","RESOLVED"],["RESOLVED","KNOWLEDGE_READY"]];
  for (const [a, b] of legs) {
    const p = FIS.pathTo(a, b);
    assert.ok(p && p.length, a + " → " + b + " 길이 없다");
    // 각 칸이 실제로 허용된 전이인지 정본으로 확인
    let cur = a;
    for (const step of p) {
      assert.ok(sm.canTransition(cur, step), cur + " → " + step + " 는 정본이 막는 길이다");
      cur = step;
    }
  }
});

test("결론 4필드: 미확정이어도 빈 칸이 나오지 않는다", () => {
  // DB 제약이 4필드 모두 비어 있지 않기를 요구한다.
  // 빈 문자열을 보내면 저장이 통째로 실패하는데 화면에는 이유가 안 보인다.
  const c = FIS.conclusionOf({
    expert_opinion: {
      cause_undetermined: true, cause_undetermined_reason_label: "추가 계측 필요",
      action_type: "점검", action_detail: "", rationale_text: "", prevention: ""
    }
  });
  for (const k of ["root_cause", "action", "evidence", "prevention"]) {
    assert.ok(c[k] && c[k].trim().length > 0, k + " 가 비어 있다");
  }
  assert.ok(/미확정/.test(c.root_cause));
});

test("결론 4필드: 확정이면 계통·부품이 원인으로 들어간다", () => {
  const c = FIS.conclusionOf({
    expert_opinion: {
      cause_undetermined: false, cause_system_label: "유압", cause_part_label: "메인펌프",
      action_type: "교체", action_detail: "메인펌프 교체", rationale_text: "압력 측정",
      prevention: "월 1회 점검"
    }
  });
  assert.strictEqual(c.root_cause, "유압 / 메인펌프");
  assert.strictEqual(c.action, "메인펌프 교체");
});

test("결론이 없으면 null — 없는 것을 만들어 보내지 않는다", () => {
  assert.strictEqual(FIS.conclusionOf({}), null);
  assert.strictEqual(FIS.replyOf({}), null);
  assert.strictEqual(FIS.resolutionOf({}), null);
});

test("해결 확인: 마지막 응답이 정본이다", () => {
  // 미해결 → 재개 → 해결 순으로 답했으면 결과는 '해결'이어야 한다
  const r = FIS.resolutionOf({ feedback: [
    { result: "unresolved", comment: "그대로입니다" },
    { result: "resolved", comment: "정상 작동합니다" }
  ]});
  assert.strictEqual(r.confirmed, true);
  assert.strictEqual(r.comment, "정상 작동합니다");
});

test("회신: 승인·발송 시각을 그대로 옮긴다", () => {
  const r = FIS.replyOf({ customer_response: {
    simplified_response: "배터리를 교체했습니다.",
    approved_at: "2026-08-25T01:00:00.000Z", delivered_at: "2026-08-25T01:05:00.000Z"
  }});
  assert.strictEqual(r.body, "배터리를 교체했습니다.");
  assert.ok(r.approved_at && r.sent_at);
});

test("설정이 비어 있으면 서버 모드로 켜지지 않는다", () => {
  // 값이 없는데 켜지면 화면이 통째로 안 뜬다. 데모로 내려가는 것이 맞다.
  assert.strictEqual(FIS.available(), false);
});

/* ── schema.sql 이 상태 정본과 어긋나지 않는가 ─────────────────────────── */
test("schema.sql 의 상태 정의가 engine/statemachine.js 와 일치한다", () => {
  const sql = fs.readFileSync(path.join(root, "supabase/schema.sql"), "utf8");
  // 허용 상태 목록
  const m = /check \(status in \(([^)]*)\)\)/.exec(sql);
  assert.ok(m, "schema.sql 에서 상태 목록 제약을 찾지 못했다");
  const inSql = m[1].split(",").map(x => x.trim().replace(/^'|'$/g, "")).sort();
  assert.deepStrictEqual(inSql, sm.STATES.slice().sort(),
    "DB 가 허용하는 상태와 화면의 상태가 다르다 — node tools/build-sql-states.js 를 돌릴 것");

  // 전이표: 정본에 있는 길이 SQL 에도 있어야 한다
  for (const from of sm.STATES) {
    const tos = (sm.TRANSITIONS[from] || []).filter(t => sm.GLOBAL_TARGETS.indexOf(t) === -1);
    if (!tos.length) continue;
    const line = new RegExp("p_from = '" + from + "' and p_to in \\(([^)]*)\\)").exec(sql);
    assert.ok(line, from + " 의 전이가 schema.sql 에 없다");
    const sqlTos = line[1].split(",").map(x => x.trim().replace(/^'|'$/g, "")).sort();
    assert.deepStrictEqual(sqlTos, tos.slice().sort(), from + " 의 전이 목록이 다르다");
  }
});

(async () => {
  for (const t of asyncTests) {
    try {
      await t.fn();
      passed++;
      console.log("  ✔ " + t.name);
    } catch (e) {
      failed++;
      console.error("  ✘ " + t.name);
      console.error("    " + (e && e.message));
    }
  }
  console.log("\n결과: " + passed + " 통과, " + failed + " 실패");
  if (failed > 0) process.exit(1);
})();
