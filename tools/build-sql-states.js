#!/usr/bin/env node
/**
 * build-sql-states.js — 상태 정의의 정본은 engine/statemachine.js 하나다.
 *
 * 왜 만들었나
 *   화면은 12개 상태(DRAFT·SUBMITTED·ASSIGNED·IN_REVIEW·PENDING_FIELD·ANSWERED
 *   ·RESOLVED·REOPENED·KNOWLEDGE_READY·MERGED·STALE·CLOSED_UNVERIFIED)로 도는데,
 *   DB 는 손으로 적은 6개(DRAFT·IN_REVIEW·CONCLUDED·REPLIED·RESOLVED·CLOSED)만
 *   허용하고 있었다. 그대로 연결하면 **접수하는 순간 거부**된다
 *   ("new row violates check constraint") — 화면에는 저장이 안 된 것으로만 보인다.
 *
 *   두 곳에 같은 규칙을 손으로 적으면 반드시 갈라진다. 그래서 한쪽에서 굽는다.
 *
 * 쓰는 법
 *   node tools/build-sql-states.js          # supabase/schema.sql 의 표시 구간을 다시 굽는다
 *   node tools/build-sql-states.js --check  # 어긋나 있으면 1 로 죽는다 (테스트용)
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.dirname(__dirname);
const SM = require(path.join(ROOT, 'engine', 'statemachine.js'));
const SQL_PATH = path.join(ROOT, 'supabase', 'schema.sql');

const BEGIN = '-- <<<GENERATED:STATES:BEGIN>>>';
const END   = '-- <<<GENERATED:STATES:END>>>';

const q = s => "'" + String(s).replace(/'/g, "''") + "'";

function build() {
  const states = SM.STATES.slice();
  const globals = SM.GLOBAL_TARGETS.slice();

  // 어느 상태에서든 갈 수 있는 목적지는 한 줄로 묶는다 — 12줄을 반복하지 않게
  const globalLine =
    `    when p_to in (${globals.map(q).join(', ')}) then true   -- 어디서든 진입 가능`;

  const lines = [];
  states.forEach(from => {
    const to = (SM.TRANSITIONS[from] || []).filter(t => globals.indexOf(t) === -1);
    if (!to.length) return;
    lines.push(
      `    when p_from = ${q(from)} and p_to in (${to.map(q).join(', ')}) then true`);
  });

  return [
    BEGIN,
    '-- ⚠ 이 구간은 engine/statemachine.js 에서 자동 생성됩니다. 손으로 고치지 마세요.',
    '--    고칠 곳은 engine/statemachine.js 이고, 그다음',
    '--    `node tools/build-sql-states.js` 를 돌리면 여기가 다시 구워집니다.',
    '--    (어긋나면 `npm test` 가 잡습니다 — tests/unit.test.js)',
    '',
    'alter table public.issue drop constraint if exists issue_status_valid;',
    'alter table public.issue add constraint issue_status_valid',
    `  check (status in (${states.map(q).join(', ')}));`,
    '',
    'create or replace function public.can_transition(p_from text, p_to text)',
    'returns boolean language sql immutable set search_path = public as $fn$',
    '  select case',
    '    when p_from = p_to then true',
    globalLine,
    ...lines,
    '    else false',
    '  end;',
    '$fn$;',
    END,
    ''
  ].join('\n');
}

function main() {
  const block = build();
  let sql = fs.readFileSync(SQL_PATH, 'utf8');
  const i = sql.indexOf(BEGIN), j = sql.indexOf(END);
  if (i === -1 || j === -1) {
    console.error('schema.sql 에 표시 구간이 없습니다:\n  ' + BEGIN + '\n  ' + END);
    process.exit(2);
  }
  const current = sql.slice(i, j + END.length + 1);
  const check = process.argv.indexOf('--check') !== -1;

  if (current.trim() === block.trim()) {
    console.log('상태 정의 일치 ✅ (' + SM.STATES.length + '개 상태)');
    return;
  }
  if (check) {
    console.error('❌ schema.sql 의 상태 정의가 engine/statemachine.js 와 다릅니다.');
    console.error('   `node tools/build-sql-states.js` 를 돌려 다시 구우세요.');
    process.exit(1);
  }
  fs.writeFileSync(SQL_PATH, sql.slice(0, i) + block + sql.slice(j + END.length + 1));
  console.log('schema.sql 상태 정의를 다시 구웠습니다 (' + SM.STATES.length + '개 상태).');
}

main();
