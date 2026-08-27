/**
 * 서버 모드 통합 테스트 — 실행: scripts/sqltest/run-server-test.sh
 *
 * 왜 이게 필요한가
 *   단위 테스트는 어댑터의 계산(경로 찾기·4필드 매핑)만 본다.
 *   SQL 하네스는 DB 규칙만 본다.
 *   **둘 사이가 맞물리는지는 아무도 안 봤다.**
 *   실제로 여기서 걸리는 것들:
 *     · 보내는 컬럼 이름이 표와 다른가
 *     · 저장 순서가 관문에 걸리는가 (결론보다 상태를 먼저 올리면 막힌다)
 *     · 상태를 한 칸씩 올리는 길이 실제로 통하는가
 *     · 읽어 온 것이 화면이 쓰던 모양으로 되돌아오는가
 *
 *   그래서 진짜 PostgreSQL 에 진짜 schema.sql 을 올리고,
 *   **고치지 않은 app/fi-supabase.js 를 그대로** 태워 한 바퀴 돌린다.
 *   supabase-js 자리에는 psql 로 말을 옮기는 가짜 클라이언트를 끼운다.
 */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { execFileSync } = require("child_process");

const root = path.join(__dirname, "..");
const PSQL = process.env.FI_PSQL;
const SOCK = process.env.FI_PGSOCK;
if (!PSQL || !SOCK) {
  console.error("이 테스트는 scripts/sqltest/run-server-test.sh 로 실행하세요.");
  process.exit(2);
}

/* ────────────────────────── psql 말 옮기기 ────────────────────────── */

function sql(text) {
  // -t -A: 머리글·정렬 없이 값만. json_agg 로 한 줄에 담아 받는다.
  const out = execFileSync(PSQL, ["-h", SOCK, "-U", "postgres", "-d", "sqltest",
    "-v", "ON_ERROR_STOP=1", "-t", "-A", "-c", text], { encoding: "utf8" });
  return out.trim();
}

function query(text) {
  try {
    // ⚠ INSERT/UPDATE/DELETE 는 서브쿼리 자리에 올 수 없다 — CTE 로 감싼다.
    //    `select ... from (insert ...)` 로 쓰면 "syntax error at or near into" 가 난다.
    const dml = /^\s*(insert|update|delete)\b/i.test(text);
    const wrapped = dml
      ? "with t as (" + text + ") select coalesce(json_agg(t), '[]'::json)::text from t"
      : "select coalesce(json_agg(t), '[]'::json)::text from (" + text + ") t";
    return { data: JSON.parse(sql(wrapped) || "[]"), error: null };
  } catch (e) {
    const msg = String((e.stderr || e.message || "")).trim();
    return { data: null, error: { message: msg } };
  }
}

/** 값 하나를 SQL 리터럴로. jsonb·배열·null 을 구분해 넣는다. */
function lit(v) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "object") return q(JSON.stringify(v)) + "::jsonb";
  return q(String(v));
}
function q(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }
function ident(s) { return '"' + String(s).replace(/"/g, '""') + '"'; }

/* ────────────────────── 가짜 supabase 클라이언트 ────────────────────── */

const UPLOADS = {};                 // '버킷/경로' → {size,type}
const MEDIA = {};                   // media_id → {blob-like}

function makeClient() {
  function table(name) {
    const st = { table: name, op: null, rows: null, sets: null, eqs: [],
                 sel: "*", ord: null, lim: null, one: false, conflict: null };

    const api = {
      select(cols) { if (st.op === null) st.op = "select"; st.sel = cols || "*"; return api; },
      insert(rows) { st.op = "insert"; st.rows = Array.isArray(rows) ? rows : [rows]; return api; },
      upsert(rows, opts) { st.op = "upsert"; st.rows = Array.isArray(rows) ? rows : [rows];
                           st.conflict = (opts && opts.onConflict) || null; return api; },
      update(patch) { st.op = "update"; st.sets = patch; return api; },
      delete() { st.op = "delete"; return api; },
      eq(col, val) { st.eqs.push([col, val]); return api; },
      neq(col, val) { st.eqs.push(["!" + col, val]); return api; },
      order(col, o) { st.ord = [col, !o || o.ascending !== false]; return api; },
      limit(n) { st.lim = n; return api; },
      maybeSingle() { st.one = "maybe"; return api; },
      single() { st.one = true; return api; },
      then(res, rej) { return run(st).then(res, rej); }
    };
    return api;
  }

  function where(st) {
    if (!st.eqs.length) return "";
    return " where " + st.eqs.map(([c, v]) =>
      c[0] === "!" ? (ident(c.slice(1)) + " <> " + lit(v)) : (ident(c) + " = " + lit(v))
    ).join(" and ");
  }

  function run(st) {
    let text, r;
    const cols = st.sel === "*" ? "*" : st.sel;

    if (st.op === "insert" || st.op === "upsert") {
      if (!st.rows.length) return Promise.resolve({ data: [], error: null });
      const keys = Object.keys(st.rows[0]);
      const values = st.rows.map(r0 => "(" + keys.map(k => lit(r0[k])).join(", ") + ")").join(", ");
      let onc = "";
      if (st.op === "upsert" && st.conflict) {
        const cs = st.conflict.split(",").map(s => ident(s.trim())).join(", ");
        const sets = keys.filter(k => st.conflict.split(",").map(s => s.trim()).indexOf(k) === -1)
          .map(k => ident(k) + " = excluded." + ident(k)).join(", ");
        onc = " on conflict (" + cs + ") do " + (sets ? "update set " + sets : "nothing");
      }
      text = "insert into public." + ident(st.table) + " (" + keys.map(ident).join(", ") + ")"
           + " values " + values + onc + " returning " + cols;
      r = query(text);
    } else if (st.op === "update") {
      const sets = Object.keys(st.sets).map(k => ident(k) + " = " + lit(st.sets[k])).join(", ");
      text = "update public." + ident(st.table) + " set " + sets + where(st) + " returning " + cols;
      r = query(text);
    } else if (st.op === "delete") {
      text = "delete from public." + ident(st.table) + where(st) + " returning " + cols;
      r = query(text);
    } else {
      text = "select " + cols + " from public." + ident(st.table) + where(st)
           + (st.ord ? " order by " + ident(st.ord[0]) + (st.ord[1] ? " asc" : " desc") : "")
           + (st.lim ? " limit " + Number(st.lim) : "");
      r = query(text);
    }

    if (r.error) return Promise.resolve({ data: null, error: r.error });
    if (st.one) {
      const rows = r.data || [];
      if (!rows.length) {
        return Promise.resolve(st.one === "maybe"
          ? { data: null, error: null }
          : { data: null, error: { message: "행이 없습니다" } });
      }
      return Promise.resolve({ data: rows[0], error: null });
    }
    return Promise.resolve({ data: r.data, error: null });
  }

  return {
    from: table,
    // 가짜 오브젝트 스토리지 — 무엇을 어느 경로에 올렸는지만 기억한다.
    // Blob 내용은 검사 대상이 아니다(브라우저가 하는 일).
    storage: {
      from(bucket) {
        return {
          upload(p, blob, opts) {
            if (!opts || opts.upsert !== true) {
              // 같은 첨부를 두 번 올릴 때 upsert 가 아니면 실제 Supabase 는 409 를 준다
              if (UPLOADS[bucket + "/" + p]) return Promise.resolve({ error: { message: "이미 있습니다" } });
            }
            UPLOADS[bucket + "/" + p] = { size: (blob && blob.size) || 0, type: (opts && opts.contentType) || null };
            return Promise.resolve({ data: { path: p }, error: null });
          },
          createSignedUrl(p, sec) {
            if (!UPLOADS[bucket + "/" + p]) return Promise.resolve({ error: { message: "없는 파일" } });
            return Promise.resolve({ data: { signedUrl: "https://local/" + bucket + "/" + p + "?exp=" + sec }, error: null });
          }
        };
      }
    },
    auth: {
      getUser: () => Promise.resolve({ data: { user: { id: "00000000-0000-0000-0000-000000000001", email: "t@x" } } }),
      getSession: () => Promise.resolve({ data: { session: { user: { id: "00000000-0000-0000-0000-000000000001" } } } }),
      signInWithPassword: () => Promise.resolve({ data: {}, error: null }),
      signOut: () => Promise.resolve({})
    }
  };
}

/* ────────────────────── 어댑터를 그대로 올린다 ────────────────────── */

const sm = require("../engine/statemachine.js");
const sandbox = { self: null, window: null, FI: { statemachine: sm },
  APP_CONFIG: { USE_SUPABASE: true, SUPABASE_URL: "http://local", SUPABASE_ANON_KEY: "local" },
  supabase: { createClient: makeClient },
  // 브라우저의 IndexedDB 자리 — 이 기기에 원본이 있는지 없는지를 흉내 낸다
  FI_MEDIA: { get: (id) => Promise.resolve(MEDIA[id] || null) },
  console };
sandbox.self = sandbox; sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, "app/fi-supabase.js"), "utf8"), sandbox);
const FIS = sandbox.FISupabase;

/* ────────────────────────── 화면이 만드는 이슈 ────────────────────────── */

function newIssue(no) {
  return {
    issue_id: no, status: "ASSIGNED",           // 접수 직후 화면이 도달하는 상태
    title: "붐 하강 + 우선회 시 충격",
    domain: "정비", intent: "trouble", scenario_id: "SC-01",
    safety_level: "일반", priority: "보통",
    equipment_ref: { model: "HX220A", sn: "3421", hours: 3410 },
    assignee_id: "expert-demo", linked_issues: [],
    user_input: { input_id: "in-" + no, input_type: "text",
      original_text: "붐 내릴 때 우측으로 돌리면 쿵 하고 충격이 옵니다",
      created_at: "2026-08-25T00:00:00.000Z", metadata: null },
    attachments: [], media_findings: null, intent_result: { domain: "정비" },
    collected: {}, questions: [
      { text: "충격은 언제부터 났습니까?", answer: "지난주부터" },
      { text: "적재 상태에서도 납니까?", answer: "예" }
    ],
    expert_checks: [], ai_analysis: null, expert_opinion: null,
    customer_response: null, feedback: [], reopen_count: 0,
    pending_request: null, notifications: [], audit: [], knowledge_entry: null,
    created_at: "2026-08-25T00:00:00.000Z"
  };
}

let passed = 0, failed = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function row(t, cond) { return query("select * from public." + ident(t) + " where " + cond).data || []; }

/* ─────────────────────────────── 검사 ─────────────────────────────── */

test("접수 직후 상태(ASSIGNED)로 저장된다 — 한 칸씩 올라간다", async () => {
  const issue = newIssue(2001);
  const n = await FIS.saveDb({ issues: [issue], knowledge: [] });
  assert.strictEqual(n, 1, "한 건이 저장되어야 한다");
  const r = row("issue", "code = 'ISSUE #2001'");
  assert.strictEqual(r.length, 1, "이슈 행이 없다");
  assert.strictEqual(r[0].status, "ASSIGNED",
    "DRAFT→SUBMITTED→ASSIGNED 로 한 칸씩 올라가야 한다 (지금: " + r[0].status + ")");
});

test("중첩된 원본이 structured 에 그대로 담긴다", async () => {
  const r = row("issue", "code = 'ISSUE #2001'");
  const st = typeof r[0].structured === "string" ? JSON.parse(r[0].structured) : r[0].structured;
  assert.strictEqual(st.issue_id, 2001);
  assert.strictEqual(st.equipment_ref.model, "HX220A");
  assert.strictEqual(st.questions.length, 2, "질문이 통째로 남아야 한다");
});

test("질문은 별도 표에도 남는다 (근거 점프용)", async () => {
  const r = row("question", "issue_id = (select id from public.issue where code='ISSUE #2001')");
  assert.strictEqual(r.length, 2);
  assert.deepStrictEqual(r.map(x => x.seq).sort(), [1, 2]);
});

test("바뀐 것이 없으면 아무것도 보내지 않는다", async () => {
  const issue = newIssue(2001);
  issue.status = "ASSIGNED";
  // 방금 보낸 것과 같은 내용 — 스냅숏과 같으므로 0 건
  const same = JSON.parse(JSON.stringify(issue));
  const n = await FIS.saveDb({ issues: [same], knowledge: [] });
  assert.strictEqual(n, 0, "같은 내용을 다시 보내면 안 된다 (" + n + "건 보냄)");
});

test("결론 없이 ANSWERED 로 올리면 DB 가 막는다", async () => {
  const issue = newIssue(2002);
  await FIS.saveDb({ issues: [issue], knowledge: [] });
  const bad = JSON.parse(JSON.stringify(issue));
  bad.status = "ANSWERED";                 // 결론·회신 없이 답변 완료로
  bad.notifications = ["x"];               // 내용도 바꿔 '변경됨'으로 잡히게
  let threw = false;
  try { await FIS.saveDb({ issues: [bad], knowledge: [] }); } catch (e) { threw = true; }
  assert.ok(threw, "막혀야 한다");
  const r = row("issue", "code = 'ISSUE #2002'");
  assert.notStrictEqual(r[0].status, "ANSWERED", "상태가 올라가 버렸다");
});

test("결론 → 회신 → 확인 순으로 한 바퀴가 돈다", async () => {
  const issue = newIssue(2003);
  await FIS.saveDb({ issues: [issue], knowledge: [] });

  // 전문가 검토 시작
  issue.status = "IN_REVIEW";
  await FIS.saveDb({ issues: [issue], knowledge: [] });
  assert.strictEqual(row("issue", "code='ISSUE #2003'")[0].status, "IN_REVIEW");

  // 결론 4필드 + 고객 회신 승인 → ANSWERED
  issue.expert_opinion = {
    original_text: "우선회 릴리프 압력 부족으로 판단",
    cause_undetermined: false, cause_system_label: "유압", cause_part_label: "선회 릴리프 밸브",
    action_type: "교체", action_detail: "선회 릴리프 밸브 교체 및 압력 재설정",
    rationale_text: "선회 압력 측정 결과 규정 대비 18% 낮음", prevention: "6개월마다 릴리프 압력 점검",
    finalized_at: "2026-08-25T02:00:00.000Z"
  };
  issue.customer_response = {
    technical_original: "릴리프 압력 부족", simplified_response: "선회 밸브를 교체했습니다.",
    approved_by: "김전문(전문가)", approved_at: "2026-08-25T03:00:00.000Z",
    delivered_at: "2026-08-25T03:01:00.000Z", delivery_status: "delivered"
  };
  issue.status = "ANSWERED";
  await FIS.saveDb({ issues: [issue], knowledge: [] });

  const c = row("conclusion", "issue_id = (select id from public.issue where code='ISSUE #2003')");
  assert.strictEqual(c.length, 1, "결론이 저장되지 않았다");
  assert.strictEqual(c[0].root_cause, "유압 / 선회 릴리프 밸브");
  const rp = row("reply", "issue_id = (select id from public.issue where code='ISSUE #2003')");
  assert.ok(rp[0].approved_at, "승인 시각이 없다");
  assert.strictEqual(row("issue", "code='ISSUE #2003'")[0].status, "ANSWERED");

  // 고객 확인 → RESOLVED
  issue.feedback = [{ result: "resolved", comment: "정상 작동합니다", responded_at: "2026-08-25T04:00:00.000Z" }];
  issue.status = "RESOLVED";
  await FIS.saveDb({ issues: [issue], knowledge: [] });
  const ri = row("issue", "code='ISSUE #2003'")[0];
  assert.strictEqual(ri.status, "RESOLVED");
  assert.ok(ri.resolved_at, "해결 시각이 자동으로 채워져야 한다");

  // Knowledge 승격
  issue.status = "KNOWLEDGE_READY";
  issue.knowledge_entry = { source_issue_id: 2003, verified: true, curated_by: null,
    reuse_count: 0, created_at: "2026-08-25T04:01:00.000Z" };
  await FIS.saveDb({ issues: [issue], knowledge: [issue.knowledge_entry] });
  const k = row("knowledge", "issue_id = (select id from public.issue where code='ISSUE #2003')");
  assert.strictEqual(k.length, 1, "Knowledge 로 승격되지 않았다");
  assert.strictEqual(k[0].root_cause, "유압 / 선회 릴리프 밸브");
});

test("고객이 미해결이라고 하면 Knowledge 로 가지 않는다", async () => {
  const issue = newIssue(2004);
  issue.status = "IN_REVIEW";
  await FIS.saveDb({ issues: [issue], knowledge: [] });
  issue.expert_opinion = {
    cause_undetermined: true, cause_undetermined_reason_label: "추가 계측 필요",
    action_type: "점검", action_detail: "", rationale_text: "", prevention: ""
  };
  issue.customer_response = { simplified_response: "점검이 더 필요합니다.",
    approved_at: "2026-08-25T03:00:00.000Z", delivered_at: "2026-08-25T03:00:00.000Z" };
  issue.status = "ANSWERED";
  await FIS.saveDb({ issues: [issue], knowledge: [] });

  // 미확정이어도 4필드가 비지 않아야 저장된다
  const c = row("conclusion", "issue_id = (select id from public.issue where code='ISSUE #2004')");
  assert.strictEqual(c.length, 1, "미확정 결론이 저장되지 않았다");
  assert.ok(/미확정/.test(c[0].root_cause));

  issue.feedback = [{ result: "unresolved", comment: "그대로입니다" }];
  issue.status = "REOPENED";
  await FIS.saveDb({ issues: [issue], knowledge: [] });
  assert.strictEqual(row("issue", "code='ISSUE #2004'")[0].status, "REOPENED");
  assert.strictEqual(
    row("knowledge", "issue_id = (select id from public.issue where code='ISSUE #2004')").length, 0,
    "미해결인데 Knowledge 에 들어갔다");
});

test("읽어 오면 화면이 쓰던 모양으로 되돌아온다", async () => {
  const loaded = await FIS.loadDb();
  assert.ok(Array.isArray(loaded.issues), "issues 가 배열이 아니다");
  const one = loaded.issues.filter(i => i.issue_id === 2003)[0];
  assert.ok(one, "#2003 이 없다");
  assert.strictEqual(one.status, "KNOWLEDGE_READY", "상태의 정본은 컬럼이어야 한다");
  assert.strictEqual(one.equipment_ref.model, "HX220A", "중첩 구조가 살아 있어야 한다");
  assert.strictEqual(one.expert_opinion.action_type, "교체");
  assert.ok(loaded.next_no > 2004, "다음 번호가 이어져야 한다 (" + loaded.next_no + ")");

  // ★ 상태의 정본은 **컬럼**이다.
  //   #2002 는 관문에 막혀 상태가 안 올라갔는데, structured 안에는 올리려던 값
  //   ('ANSWERED')이 그대로 남아 있다. 그것을 믿으면 화면이 "답변 완료"로 보이고
  //   전문가는 다 끝난 줄 안다. 컬럼을 믿어야 한다.
  const blocked = loaded.issues.filter(i => i.issue_id === 2002)[0];
  assert.ok(blocked, "#2002 가 없다");
  // ASSIGNED → IN_REVIEW 까지는 통과하고 IN_REVIEW → ANSWERED 에서 막힌다.
  // 한 칸씩 올리므로 **갈 수 있는 데까지 가고 거기서 선다.** 중간 상태도 정당한
  // 상태라 해롭지 않고, 다음에 읽을 때 컬럼 값으로 화면이 스스로 맞춰진다.
  assert.strictEqual(blocked.status, "IN_REVIEW",
    "막힌 이슈는 컬럼 상태로 돌아와야 한다 (structured 안의 값을 믿으면 안 된다)");
  const raw2002 = row("issue", "code = 'ISSUE #2002'")[0];
  const st2002 = typeof raw2002.structured === "string" ? JSON.parse(raw2002.structured) : raw2002.structured;
  assert.strictEqual(st2002.status, "ANSWERED",
    "이 검사가 성립하려면 structured 와 컬럼이 실제로 어긋나 있어야 한다");
});

test("다시 읽은 뒤 저장하면 중복으로 넣지 않는다", async () => {
  const loaded = await FIS.loadDb();
  const before = query("select count(*)::int as n from public.issue").data[0].n;
  const n = await FIS.saveDb(loaded);
  assert.strictEqual(n, 0, "읽어 온 그대로면 보낼 것이 없어야 한다");
  const after = query("select count(*)::int as n from public.issue").data[0].n;
  assert.strictEqual(after, before, "이슈가 늘어났다");
});

test("현장 사진·녹음이 서버로 올라가고 참조가 남는다", async () => {
  const issue = newIssue(2010);
  issue.attachments = [
    { media_id: "m-img-1", input_type: "image", kind: "image", name: "현장 사진",
      mime: "image/jpeg", size: 120000, transcript: null },
    { media_id: "m-aud-1", input_type: "voice", kind: "audio", name: "음성 녹음 1",
      mime: "audio/webm", size: 48000, duration_ms: 7200, transcript: null }
  ];
  MEDIA["m-img-1"] = { media_id: "m-img-1", mime: "image/jpeg", blob: { size: 120000 } };
  MEDIA["m-aud-1"] = { media_id: "m-aud-1", mime: "audio/webm", blob: { size: 48000 } };

  await FIS.saveDb({ issues: [issue], knowledge: [] });

  const a = row("attachment", "issue_id = (select id from public.issue where code='ISSUE #2010') order by file_name");
  assert.strictEqual(a.length, 2, "첨부 참조가 2건이어야 한다 (지금 " + a.length + ")");
  const byName = {}; a.forEach(x => { byName[x.file_name] = x; });
  assert.strictEqual(byName["m-aud-1"].kind, "audio", "voice 는 audio 로 옮겨져야 한다(표의 check 제약)");
  assert.strictEqual(byName["m-img-1"].kind, "image");
  assert.ok(byName["m-img-1"].storage_path, "저장 경로가 비어 있다");

  // 실제로 올라갔는가
  assert.ok(UPLOADS["field-insight/" + byName["m-img-1"].storage_path], "사진이 버킷에 없다");
  assert.ok(UPLOADS["field-insight/" + byName["m-aud-1"].storage_path], "녹음이 버킷에 없다");
});

test("kind 에 'voice' 가 들어와도 표의 허용값으로 옮겨 담는다", async () => {
  // 표의 check 는 image/video/audio/file 만 받는다. 화면 쪽 낱말('voice')이
  // 그대로 오면 insert 가 죽고 **이슈 저장까지 통째로** 날아간다.
  const issue = newIssue(2012);
  issue.attachments = [{ media_id: "m-voice-1", kind: "voice", mime: "audio/webm", size: 100 }];
  MEDIA["m-voice-1"] = { media_id: "m-voice-1", mime: "audio/webm", blob: { size: 100 } };
  await FIS.saveDb({ issues: [issue], knowledge: [] });
  const a = row("attachment", "issue_id = (select id from public.issue where code='ISSUE #2012')");
  assert.strictEqual(a.length, 1, "첨부가 저장되지 않았다 — 허용값으로 안 옮겨졌을 것이다");
  assert.strictEqual(a[0].kind, "audio");
});

test("경로에 '#'·공백이 들어가지 않는다", async () => {
  // 이슈 코드가 'ISSUE #2010' 이다. 그대로 경로에 쓰면 주소가 깨진다.
  const p = FIS.mediaPath("ISSUE #2010", "m-img-1", "image/jpeg");
  assert.ok(!/[#\s]/.test(p), "경로에 위험한 글자가 있다: " + p);
  assert.ok(/\.jpg$/.test(p), "확장자가 mime 에서 나와야 한다: " + p);
});

test("다시 저장해도 첨부 행이 늘어나지 않는다", async () => {
  const issue = newIssue(2010);
  issue.attachments = [
    { media_id: "m-img-1", kind: "image", mime: "image/jpeg", size: 120000 },
    { media_id: "m-aud-1", kind: "audio", mime: "audio/webm", size: 48000 }
  ];
  issue.notifications = ["다시 저장"];         // 내용을 바꿔 '변경됨'으로 잡히게
  await FIS.saveDb({ issues: [issue], knowledge: [] });
  const a = row("attachment", "issue_id = (select id from public.issue where code='ISSUE #2010')");
  assert.strictEqual(a.length, 2, "같은 첨부가 중복으로 쌓였다 (" + a.length + "건)");
});

test("이 기기에 원본이 없으면 서명 주소로 받아 볼 수 있다", async () => {
  // 전문가는 남이 찍은 사진을 본다 — 그 기기 IndexedDB 에는 원본이 없다.
  const a = row("attachment", "issue_id = (select id from public.issue where code='ISSUE #2010') and file_name='m-img-1'");
  const url = await FIS.signedUrl(a[0].storage_path);
  assert.ok(/^https:\/\/local\/field-insight\//.test(url), "서명 주소가 아니다: " + url);
});

test("원본이 없는 첨부는 건너뛰고 이슈 저장은 살린다", async () => {
  // 전문가가 남의 이슈를 고쳐 저장할 때, 그 기기에는 첨부 원본이 없다.
  // 그때 첨부 때문에 이슈 저장이 통째로 실패하면 안 된다.
  const issue = newIssue(2011);
  issue.attachments = [{ media_id: "m-없는것", kind: "image", mime: "image/png", size: 1 }];
  const n = await FIS.saveDb({ issues: [issue], knowledge: [] });
  assert.strictEqual(n, 1, "이슈는 저장되어야 한다");
  assert.strictEqual(row("issue", "code='ISSUE #2011'").length, 1);
  assert.strictEqual(
    row("attachment", "issue_id = (select id from public.issue where code='ISSUE #2011')").length, 0,
    "원본이 없는데 참조가 생겼다");
});

(async () => {
  for (const t of tests) {
    try { await t.fn(); passed++; console.log("  ✔ " + t.name); }
    catch (e) { failed++; console.error("  ✘ " + t.name); console.error("    " + (e && e.message)); }
  }
  console.log("\n결과: " + passed + " 통과, " + failed + " 실패");
  if (failed > 0) process.exit(1);
})();
