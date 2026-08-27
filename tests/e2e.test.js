/**
 * E2E 테스트 — 실행: node tests/e2e.test.js
 *
 * 원문 15장 End-to-End 시나리오 전체 루프 1회전 (Playwright + Chromium):
 *   [A] 시드 버튼 → ISSUE #1024 가 IN_REVIEW 로 재현되는지
 *   [B] 접수자 입력 → 질문 3개 답변 → 선택적 확인 → 접수 → 전문가 큐 → 상세(근거 점프)
 *       → AI 분석(B판정) → 4필드 결론 확정(SW-HYD-0412) → 승인 발송 → 접수자 답변 확인
 *       → [해결됨] → KNOWLEDGE_READY(지식 승격 후보) 확인
 *
 * Playwright 로딩: 로컬 node_modules → PLAYWRIGHT_DIR 환경변수 → CI 스크래치 경로 순.
 */
"use strict";
const assert = require("assert");
const http = require("http");
const fs = require("fs");
const path = require("path");

function loadPlaywright() {
  const candidates = [
    "playwright",
    process.env.PLAYWRIGHT_DIR,
    "/tmp/claude-0/-home-user-hd-project01/8ebdfff2-5164-5f62-89ea-9104243fb2c1/scratchpad/node_modules/playwright"
  ].filter(Boolean);
  for (const c of candidates) {
    try { return require(c); } catch (e) { /* 다음 후보 */ }
  }
  throw new Error("playwright 를 찾을 수 없습니다. npm i playwright 후 재실행하거나 PLAYWRIGHT_DIR 을 지정하세요.");
}

const ROOT = path.join(__dirname, "..");
const SHOT_DIR = process.env.E2E_SHOT_DIR || __dirname; // 스크린샷 저장 위치
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split("?")[0]);
      const filePath = path.join(ROOT, urlPath === "/" ? "/app/index.html" : urlPath);
      if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        res.writeHead(404); res.end("not found"); return;
      }
      res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
      res.end(fs.readFileSync(filePath));
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function waitText(page, selector, substr) {
  await page.waitForFunction(
    ([sel, sub]) => {
      const el = document.querySelector(sel);
      return !!el && el.textContent.indexOf(sub) >= 0;
    },
    [selector, substr],
    { timeout: 8000 }
  ).catch(async (e) => {
    const actual = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return el ? el.textContent.slice(0, 300) : "(요소 없음)";
    }, selector);
    throw new Error(`"${selector}" 에 "${substr}" 미출현. 실제: ${actual}`);
  });
}

async function clickOption(page, label) {
  await page.locator("button.option-btn").filter({ hasText: new RegExp("^" + label + "$") }).first().click();
}

(async () => {
  const { chromium } = loadPlaywright();
  const server = await startServer();
  const base = "http://127.0.0.1:" + server.address().port;
  const executablePath = fs.existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined;
  const browser = await chromium.launch({
    executablePath,
    args: ["--no-sandbox", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"]
  });
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  // Web Speech API 는 headless 에서 동작하지 않으므로 가짜 SpeechRecognition 주입(STT 어댑터가 __FI_TEST_SR 우선 사용)
  await page.addInitScript(() => {
    window.__FI_TEST_SR = class {
      constructor() { this.onresult = null; this.onend = null; this.onerror = null; }
      start() {
        this._t = setTimeout(() => {
          if (!this.onresult) return;
          const results = [Object.assign(
            [{ transcript: "붐을 내리고 오른쪽으로 돌면 가끔 덜컹거립니다." }],
            { isFinal: true }
          )];
          this.onresult({ resultIndex: 0, results });
        }, 250);
      }
      stop() { clearTimeout(this._t); if (this.onend) this.onend(); }
    };
  });
  page.on("dialog", (d) => d.accept());
  page.on("pageerror", (e) => console.error("  [pageerror]", e.message));

  let step = 0;
  const ok = (msg) => console.log("  ✔ " + (++step) + ". " + msg);

  try {
    /* ───────── [A] 시드 데모: ISSUE #1024 가 IN_REVIEW 로 재현 ───────── */
    console.log("\n[A] 시드 로드 — 15장 시나리오 IN_REVIEW 재현");
    await page.goto(base + "/app/index.html");
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.click("#btn-load-seed");
    await waitText(page, "#queue-active", "#1024");
    await waitText(page, "#queue-active", "검토 중");
    await waitText(page, "#queue-active", "정보충분도");
    ok("시드 로드 → 전문가 큐에 #1024 (IN_REVIEW)");
    await page.locator("#queue-active .btn-open").first().click();
    await waitText(page, "#issue-detail", "ISSUE #1024");
    await waitText(page, "#original-text", "붐을 내리고 오른쪽으로 돌면 가끔 덜컹거립니다");
    await waitText(page, "#issue-detail", "유압 온도");
    ok("시드 상세: 고객 원문 + 전문가 추가 확인 항목(유압 온도) 표시");

    /* ───────── [B] 전체 루프 1회전 (새 이슈 접수부터) ───────── */
    console.log("\n[B] 전체 루프 1회전 — 접수 → 전문가 판단 → 회신 → 해결 확인");
    await page.evaluate(() => localStorage.clear());
    await page.reload();

    // 접수자: C-01 입력 + 장비 선택
    await page.click("#btn-new-issue");
    await page.fill("#input-text", "붐을 내리고 오른쪽으로 돌면 가끔 덜컹거립니다.");
    await page.selectOption("#select-equipment", "0"); // HX220A · SN 3421 · 3,410h
    await page.click("#btn-analyze");
    ok("C-01: 텍스트 입력 + HX220A 장비 선택");

    // C-02: 질문 3개 (재현성 → 예열 → 정비이력), 진행 표시/모르겠음 확인
    await waitText(page, "#q-progress", "(1/3)");
    await waitText(page, "#q-text", "이 현상은 언제 발생하나요?");
    const unknownCount = await page.locator('button.option-btn:text-is("모르겠음")').count();
    assert.ok(unknownCount >= 1, "질문에 [모르겠음] 포함(P4)");
    await clickOption(page, "가끔");
    await waitText(page, "#q-progress", "(2/3)");
    await waitText(page, "#q-text", "시동 직후에도 발생하나요?");
    await clickOption(page, "시동 직후");
    await waitText(page, "#q-progress", "(3/3)");
    await waitText(page, "#q-text", "최근 1개월 내 정비 이력이 있나요?");
    await clickOption(page, "없음");
    ok("C-02: 질문 3개 답변 (진행 표시 1/3~3/3, [모르겠음] 노출)");

    // C-03: 선택적 확인 — 저신뢰(빈도 0.6) 1건만 강조 → [맞아요] → 접수하기
    await waitText(page, "#view-c03", "이렇게 이해했습니다");
    const boxCount = await page.locator(".lowconf-box").count();
    assert.strictEqual(boxCount, 1, "저신뢰 강조 박스는 1건(빈도)만");
    await waitText(page, ".lowconf-box", "발생 빈도");
    await waitText(page, ".lowconf-box", "가끔 발생");
    await waitText(page, "#view-c03", "고객 원문");
    await page.click(".btn-confirm-ok");
    await page.click("#btn-submit-issue");
    await waitText(page, "#cdetail-status", "배정됨");
    await waitText(page, "main", "#1024");
    ok("C-03: ⚠ 발생 빈도만 확인([맞아요]) → 접수하기 → ISSUE #1024 (ASSIGNED)");

    // 전문가 모드: E-01 큐 → 열기(IN_REVIEW 전이)
    await page.click("#mode-expert");
    await waitText(page, "#queue-active", "#1024");
    await waitText(page, "#queue-active", "정보충분도");
    await page.locator("#queue-active .btn-open").first().click();
    await waitText(page, "#edetail-status", "검토 중");
    ok("E-01: My Queue(진행중 레인) → 열기 → IN_REVIEW");

    // E-02: 근거 점프 — 근거 링크 클릭 시 원문 구간 하이라이트
    await waitText(page, "#issue-detail", "정형화 결과");
    await waitText(page, "#issue-detail", "붐 하강 + 우선회");
    await page.locator(".evidence-link").first().click();
    const hl = await page.locator("#original-text mark.hl").textContent();
    assert.ok(["덜컹", "돌면", "붐을 내리"].some((k) => hl.indexOf(k) >= 0), "하이라이트 구간: " + hl);
    ok("E-02: 근거 링크 클릭 → 고객 원문 하이라이트('" + hl + "')");

    // E-03: Mock AI 분석 — B판정, Case #0832 87%, Manual 4-2, 한계 명시
    await page.click("#btn-run-ai");
    await waitText(page, "#ai-result", "판정 B");
    await waitText(page, "#ai-result", "Case #0832");
    await waitText(page, "#ai-result", "87%");
    await waitText(page, "#ai-result", "Manual 4-2");
    await waitText(page, "#ai-result", "유압 온도");
    ok("E-03: AI 분석 B판정 · Case #0832(87%) · Manual 4-2 · 한계 명시");

    // E-04: 자유 서술 → AI 초안 → 4필드 확정 (SW-HYD-0412)
    await page.fill("#expert-free-text",
      "유압 오일 온도가 낮은 상태에서 선회 압력이 순간적으로 상승해서 발생하는 현상으로 판단됩니다. " +
      "예열 후 재현 확인하고 미재현 시 정상 판정하면 됩니다. 동절기 예열 절차 안내가 필요합니다.");
    await page.click("#btn-ai-draft");
    await waitText(page, "#selected-part-code", "SW-HYD-0412");
    await waitText(page, "#selected-part-label", "선회 유압 계통");
    assert.strictEqual(await page.locator("#action-type").inputValue(), "안내");
    const checks = page.locator(".rationale-check");
    const n = await checks.count();
    for (let i = 0; i < n; i++) await checks.nth(i).check(); // Case #0832 · Manual 4-2 · 전문가 경험
    await page.click("#btn-finalize");
    await waitText(page, "#final-cause", "SW-HYD-0412");
    await waitText(page, "#opinion-section", "선회 모터 릴리프 밸브");
    ok("E-04: AI 4필드 초안(SW-HYD-0412/안내) → 결론 확정");

    // E-05: 전문가 원본 vs 고객용 재작성 → 승인 후 발송
    await waitText(page, "#tech-original", "유압 오일 온도가 낮은 상태");
    const rewrite = await page.locator("#customer-rewrite").inputValue();
    assert.ok(rewrite.indexOf("장비가 충분히 예열되지 않은 상태") >= 0, "고객 언어 변환");
    assert.ok(rewrite.indexOf("유압") < 0, "기술 용어 제거");
    await page.click("#btn-approve-send");
    await waitText(page, "#edetail-status", "답변 완료");
    ok("E-05: 승인 후 발송 → ANSWERED (CustomerResponse 별도 저장)");

    // 접수자 모드: C-05 답변 확인 → [해결됨] → KNOWLEDGE_READY
    await page.click("#mode-reporter");
    await waitText(page, "#issue-list", "답변 완료");
    await page.locator(".issue-item").first().click();
    await waitText(page, "#answer-view", "예열되지 않은 상태");
    await page.click("#btn-resolved");
    await waitText(page, "#cdetail-status", "지식 승격 후보");
    await waitText(page, "#resolved-note", "Knowledge");
    ok("C-05: [해결됨] → RESOLVED → KNOWLEDGE_READY(지식 승격 후보)");

    // 저장 데이터 최종 검증 (상태머신 이력 + Knowledge 게이트, FR-25/DP-8)
    const finalDb = await page.evaluate(() => JSON.parse(localStorage.getItem("field_insight_db_v1")));
    const issue = finalDb.issues.filter((i) => i.issue_id === 1024)[0];
    assert.strictEqual(issue.status, "KNOWLEDGE_READY");
    assert.strictEqual(issue.expert_opinion.cause_part_code, "SW-HYD-0412");
    assert.strictEqual(issue.customer_response.delivery_status, "delivered");
    assert.strictEqual(issue.feedback[0].result, "resolved");
    assert.strictEqual(finalDb.knowledge.length, 1);
    const chain = issue.audit.filter((a) => a.event === "status_change").map((a) => a.detail.to);
    assert.deepStrictEqual(chain,
      ["SUBMITTED", "ASSIGNED", "IN_REVIEW", "ANSWERED", "RESOLVED", "KNOWLEDGE_READY"]);
    assert.ok(issue.user_input.original_text.indexOf("덜컹거립니다") >= 0, "원본 불변(DP-1)");
    ok("저장 검증: 상태 이력 체인 · SW-HYD-0412 · Knowledge 1건 · 원본 보존");

    /* ───────── [C] 2차 고도화: 음성 녹음+STT, 이미지 첨부, IndexedDB, 음성 근거 점프 ───────── */
    console.log("\n[C] 음성·미디어 접수 — 녹음/STT/IndexedDB/세그먼트 근거 점프");
    await page.evaluate(() => Promise.all([
      Promise.resolve(localStorage.clear()),
      window.FI_MEDIA.clear()
    ]));
    await page.reload();
    await page.click("#btn-new-issue");
    await page.screenshot({ path: path.join(SHOT_DIR, "c01-voice.png"), fullPage: true });

    // 녹음 시작 → 오버레이 + 가짜 STT 실시간 전사 → 텍스트 자동 삽입
    await page.click("#btn-record");
    await page.waitForSelector("#rec-overlay", { timeout: 8000 });
    await page.waitForFunction(() => {
      const ta = document.getElementById("input-text");
      return ta && ta.value.indexOf("덜컹거립니다") >= 0;
    }, null, { timeout: 8000 });
    ok("C-01: 녹음 시작(가짜 마이크) → 오버레이 표시 + STT 전사 텍스트 자동 삽입");

    // 녹음 정지 → 오디오 Blob 이 IndexedDB 에 저장되고 첨부 목록에 표시
    await page.click("#btn-record-stop");
    await waitText(page, "#draft-attachments", "음성 녹음 1");
    await waitText(page, "#draft-attachments", "전사 1구간");
    assert.strictEqual(await page.evaluate(() => window.FI_MEDIA.count()), 1, "IndexedDB 오디오 1건");
    ok("C-01: 녹음 정지 → IndexedDB 저장(1건) + 첨부 목록(전사 세그먼트 포함)");

    // 이미지 첨부 (1×1 PNG 실제 파일)
    const PNG_1PX = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64");
    await page.setInputFiles("#input-image", { name: "현장사진.png", mimeType: "image/png", buffer: PNG_1PX });
    await waitText(page, "#draft-attachments", "현장사진.png");
    assert.strictEqual(await page.evaluate(() => window.FI_MEDIA.count()), 2, "IndexedDB 이미지 포함 2건");
    await page.screenshot({ path: path.join(SHOT_DIR, "c01-attached.png"), fullPage: true });
    ok("C-01: 이미지 첨부(setInputFiles) → 썸네일 + IndexedDB 2건");

    // 질문 3개 → 확인 → 접수 (텍스트는 STT 로 채워진 값 그대로)
    await page.selectOption("#select-equipment", "0");
    await page.click("#btn-analyze");
    await waitText(page, "#q-progress", "(1/3)");
    await clickOption(page, "가끔");
    await clickOption(page, "시동 직후");
    await clickOption(page, "없음");
    await waitText(page, "#view-c03", "이렇게 이해했습니다");
    await waitText(page, "#view-c03", "첨부 (2건)");
    await page.click(".btn-confirm-ok");
    await page.click("#btn-submit-issue");
    await waitText(page, "#cdetail-status", "배정됨");
    ok("C-02/03: STT 텍스트로 동일 질문 3개 → 첨부 2건 표시 → 접수(ASSIGNED)");

    // 전문가 상세: 첨부 원본(오디오+세그먼트 칩+이미지) 표시, 근거 점프 시 세그먼트 활성
    await page.click("#mode-expert");
    await page.locator("#queue-active .btn-open").first().click();
    await waitText(page, "#issue-attachments", "음성 녹음 1");
    assert.ok(await page.locator("#issue-attachments audio").count() >= 1, "오디오 플레이어");
    assert.ok(await page.locator("#issue-attachments img.att-thumb").count() >= 1, "이미지 썸네일");
    assert.ok(await page.locator(".seg-chip").count() >= 1, "전사 세그먼트 칩");
    await page.locator(".evidence-link").first().click();
    await page.waitForSelector("#original-text mark.hl", { timeout: 8000 });
    await page.waitForSelector(".seg-chip.seg-active", { timeout: 8000 });
    await page.screenshot({ path: path.join(SHOT_DIR, "e02-media.png"), fullPage: true });
    ok("E-02: 근거 링크 클릭 → 원문 하이라이트 + 해당 음성 세그먼트 활성(재생 지점 매핑)");

    // 저장 구조 검증: 첨부 참조 + 전사 char 매핑 (Blob 은 IndexedDB, Issue 엔 참조만 — DP-1)
    const mediaDb = await page.evaluate(() => JSON.parse(localStorage.getItem("field_insight_db_v1")));
    const mIssue = mediaDb.issues[mediaDb.issues.length - 1];
    assert.strictEqual(mIssue.attachments.length, 2);
    const voiceAtt = mIssue.attachments.filter((a) => a.kind === "audio")[0];
    assert.strictEqual(voiceAtt.input_type, "voice");
    assert.ok(voiceAtt.media_id && !voiceAtt.blob, "Issue 에는 media_id 참조만 저장");
    assert.strictEqual(voiceAtt.transcript.length, 1);
    assert.strictEqual(voiceAtt.transcript[0].char_start, 0, "전사 세그먼트 ↔ 최종 텍스트 char 매핑");
    assert.ok(voiceAtt.transcript[0].end_ms > 0, "세그먼트 타임스탬프(ms)");
    assert.strictEqual(mIssue.user_input.input_type, "multimodal");
    ok("저장 검증: 첨부 2건(참조만) · transcript {text,start_ms,end_ms,char_*} 스키마");

    console.log("\nE2E 통과: 전체 루프 1회전 + 음성·미디어 접수 (" + step + "단계)\n");
    await browser.close();
    server.close();
    process.exit(0);
  } catch (e) {
    console.error("\nE2E 실패: " + e.message + "\n");
    try {
      await page.screenshot({ path: path.join(__dirname, "e2e-failure.png"), fullPage: true });
      console.error("스크린샷: tests/e2e-failure.png");
    } catch (e2) {}
    await browser.close();
    server.close();
    process.exit(1);
  }
})();
