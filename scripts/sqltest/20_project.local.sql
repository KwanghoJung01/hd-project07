-- 로컬 검증 전용 — hd-project07 (운영 실행 금지)
--
-- 여기서 검사하는 것은 **화면이 아니라 DB 가 지키는 규칙**이다.
-- 상태 목록·전이표는 engine/statemachine.js 가 정본이고,
-- schema.sql 의 GENERATED 구간은 tools/build-sql-states.js 가 굽는다.
-- 아래 단정문은 그 정본과 같은 흐름을 적은 것이다.
do $guard$
begin
  if exists (select 1 from pg_roles where rolname in ('supabase_admin','authenticator'))
     or exists (select 1 from pg_namespace where nspname='graphql') then
    raise exception '이 파일은 로컬 검증 전용입니다.';
  end if;
end;
$guard$;

do $t$ begin raise notice '[프로젝트] 상태 기계 · 결론 4필드 · Knowledge 축적 규칙'; end $t$;

-- ── 전이표: 화면과 같은 길만 열려 있는가 ──────────────────────────────
do $t$ begin
  perform public._assert(    public.can_transition('DRAFT','SUBMITTED'),      '접수 → 제출');
  perform public._assert(    public.can_transition('SUBMITTED','ASSIGNED'),   '제출 → 배정');
  perform public._assert(    public.can_transition('ASSIGNED','IN_REVIEW'),   '배정 → 검토');
  perform public._assert(    public.can_transition('IN_REVIEW','PENDING_FIELD'), '검토 → 현장 확인 대기');
  perform public._assert(    public.can_transition('PENDING_FIELD','IN_REVIEW'), '현장 확인 → 검토 복귀');
  perform public._assert(    public.can_transition('IN_REVIEW','ANSWERED'),   '검토 → 답변');
  perform public._assert(    public.can_transition('ANSWERED','RESOLVED'),    '답변 → 해결');
  perform public._assert(    public.can_transition('ANSWERED','REOPENED'),    '답변 → 재개(미해결)');
  perform public._assert(    public.can_transition('REOPENED','IN_REVIEW'),   '재개 → 검토');
  perform public._assert(    public.can_transition('RESOLVED','KNOWLEDGE_READY'), '해결 → 지식 승격');

  -- 어디서든 갈 수 있는 종결 상태
  perform public._assert(    public.can_transition('DRAFT','STALE'),          '어디서든 보류로 갈 수 있다');
  perform public._assert(    public.can_transition('IN_REVIEW','MERGED'),     '어디서든 병합으로 갈 수 있다');

  -- 건너뛰기는 막힌다
  perform public._assert(not public.can_transition('DRAFT','IN_REVIEW'),      '접수에서 검토로 건너뛸 수 없다');
  perform public._assert(not public.can_transition('DRAFT','RESOLVED'),       '접수에서 해결로 건너뛸 수 없다');
  perform public._assert(not public.can_transition('IN_REVIEW','RESOLVED'),   '검토에서 해결로 건너뛸 수 없다');
  perform public._assert(not public.can_transition('KNOWLEDGE_READY','DRAFT'),'승격된 것을 되살릴 수 없다');
  perform public._assert(not public.can_transition('STALE','IN_REVIEW'),      '보류에서 되돌릴 수 없다');

  -- 정의되지 않은 상태는 아예 통하지 않는다 (옛 이름이 남아 있으면 여기서 잡힌다)
  perform public._assert(not public.can_transition('DRAFT','CONCLUDED'),      '옛 상태 이름(CONCLUDED)은 통하지 않는다');
  perform public._assert(not public.can_transition('ANSWERED','REPLIED'),     '옛 상태 이름(REPLIED)은 통하지 않는다');
end $t$;

-- ── 허용 상태 목록이 화면과 같은가 ────────────────────────────────────
do $t$
declare v_r boolean;
begin
  v_r := false;
  begin
    insert into public.issue (code, title, raw_text, status)
    values ('T-BAD','옛 상태','x','CONCLUDED');
  exception when check_violation then v_r := true;
  end;
  perform public._assert(v_r, '정의되지 않은 상태는 제약이 막는다');
end $t$;

-- ── 실제 흐름 한 바퀴 ─────────────────────────────────────────────────
do $t$
declare v_id bigint; v_r boolean;
begin
  insert into public.issue (code, title, raw_text)
  values ('T-1001','시동이 안 걸립니다','아침에 키를 돌려도 반응이 없어요')
  on conflict (code) do nothing;
  select id into v_id from public.issue where code='T-1001';

  perform public._assert_eq((select status from public.issue where id=v_id), 'DRAFT', '처음은 DRAFT');

  -- 건너뛰기는 트리거가 막는다 (화면이 아니라 DB 가 막는 것이 요점)
  v_r := false;
  begin update public.issue set status='RESOLVED' where id=v_id;
  exception when others then v_r := true; end;
  perform public._assert(v_r, 'DRAFT 에서 RESOLVED 로 바로 갈 수 없다');

  update public.issue set status='SUBMITTED' where id=v_id;
  update public.issue set status='ASSIGNED'  where id=v_id;
  update public.issue set status='IN_REVIEW' where id=v_id;
  perform public._assert_eq((select status from public.issue where id=v_id), 'IN_REVIEW', '접수→제출→배정→검토');

  -- 결론이 없으면 ANSWERED 로 못 간다
  v_r := false;
  begin update public.issue set status='ANSWERED' where id=v_id;
  exception when others then v_r := true; end;
  perform public._assert(v_r, '결론이 없으면 ANSWERED 로 갈 수 없다');

  -- 4필드 중 하나라도 비면 결론이 아니다
  v_r := false;
  begin
    insert into public.conclusion (issue_id, root_cause, action, evidence, prevention)
    values (v_id, '배터리 방전', '교체', '', '주기 점검');
  exception when check_violation then v_r := true; end;
  perform public._assert(v_r, '근거가 비면 결론으로 저장되지 않는다');

  insert into public.conclusion (issue_id, root_cause, action, evidence, prevention)
  values (v_id, '배터리 방전', '배터리 교체', '전압 측정 10.2V', '월 1회 전압 점검');

  -- 결론만으로도 아직 부족하다 — 승인된 회신이 있어야 답변이다
  v_r := false;
  begin update public.issue set status='ANSWERED' where id=v_id;
  exception when others then v_r := true; end;
  perform public._assert(v_r, '결론만 있고 회신이 없으면 ANSWERED 로 갈 수 없다');

  insert into public.reply (issue_id, body) values (v_id, '배터리를 교체했습니다.');
  v_r := false;
  begin update public.issue set status='ANSWERED' where id=v_id;
  exception when others then v_r := true; end;
  perform public._assert(v_r, '승인되지 않은 회신으로는 ANSWERED 로 갈 수 없다');

  -- 승인 전에 발송할 수 없다
  v_r := false;
  begin update public.reply set sent_at = now() where issue_id = v_id;
  exception when check_violation then v_r := true; end;
  perform public._assert(v_r, '승인 전에는 발송 시각을 남길 수 없다');

  update public.reply set approved_at = now() where issue_id = v_id;
  update public.issue set status='ANSWERED' where id=v_id;
  perform public._assert_eq((select status from public.issue where id=v_id), 'ANSWERED',
    '결론 + 승인된 회신이 있으면 ANSWERED 로 간다');

  -- ★ 고객 확인 없이 전문가가 혼자 닫을 수 없다
  v_r := false;
  begin update public.issue set status='RESOLVED' where id=v_id;
  exception when others then v_r := true; end;
  perform public._assert(v_r, '고객 확인 없이 RESOLVED 로 갈 수 없다');

  -- 고객이 "해결 안 됐다"고 하면 그래도 안 된다
  insert into public.resolution (issue_id, confirmed, comment)
  values (v_id, false, '아직 같은 증상이 납니다');
  v_r := false;
  begin update public.issue set status='RESOLVED' where id=v_id;
  exception when others then v_r := true; end;
  perform public._assert(v_r, '고객이 미해결이라고 하면 RESOLVED 로 갈 수 없다');

  -- 확인되면 넘어간다
  update public.resolution set confirmed = true where issue_id = v_id;
  update public.issue set status='RESOLVED' where id=v_id;
  perform public._assert_eq((select status from public.issue where id=v_id), 'RESOLVED',
    '고객이 확인하면 RESOLVED 로 간다');
  perform public._assert(
    (select resolved_at from public.issue where id=v_id) is not null,
    'RESOLVED 로 가면 해결 시각이 자동으로 채워진다');

  -- ★ 핵심: 고객이 확인한 사례만 Knowledge 로 간다
  update public.issue set status='KNOWLEDGE_READY' where id=v_id;
  insert into public.knowledge (issue_id, title, root_cause, action, prevention, tags)
  values (v_id, '시동 불량 — 배터리 방전', '배터리 방전', '배터리 교체', '월 1회 전압 점검',
          array['시동','배터리']);
  perform public._assert_eq(
    (select count(*) from public.knowledge where issue_id=v_id), 1::bigint,
    '고객이 확인한 사례는 Knowledge 로 축적된다');

  -- 재발해서 되돌리면 해결 시각도 비워진다
  update public.issue set status='STALE' where id=v_id;
  perform public._assert(
    (select resolved_at from public.issue where id=v_id) is null,
    '해결 상태를 벗어나면 해결 시각도 함께 비워진다');

  -- 질문은 3개까지
  v_r := false;
  begin insert into public.question (issue_id, seq, question) values (v_id, 4, '네 번째 질문');
  exception when check_violation then v_r := true; end;
  perform public._assert(v_r, '판단을 바꿀 질문은 3개까지 (check 제약)');

  -- 역할 표기
  v_r := false;
  begin
    insert into public.app_user (user_id, name, roles)
    values ('33333333-3333-3333-3333-333333333333','X', array['superuser']);
  exception when check_violation then v_r := true; end;
  perform public._assert(v_r, '정의되지 않은 역할은 check 제약이 막는다');

  v_r := false;
  begin
    insert into public.app_user (user_id, name, roles)
    values ('44444444-4444-4444-4444-444444444444','Y', array[]::text[]);
  exception when check_violation then v_r := true; end;
  perform public._assert(v_r, '역할이 하나도 없는 사용자는 막는다');
end $t$;

-- ── 관문이 INSERT 로도 우회되지 않는가 ────────────────────────────────
--   UPDATE 에만 걸어 두면 처음부터 ANSWERED 로 넣는 길이 열린다.
do $t$
declare v_r boolean;
begin
  v_r := false;
  begin
    insert into public.issue (code, title, raw_text, status)
    values ('T-BYPASS','우회 시도','결론도 회신도 없이 답변 완료로 만들기','ANSWERED');
  exception when others then v_r := true; end;
  perform public._assert(v_r, '처음부터 ANSWERED 로 만들어 넣을 수 없다 (INSERT 도 관문을 지난다)');

  v_r := false;
  begin
    insert into public.issue (code, title, raw_text, status)
    values ('T-BYPASS2','우회 시도2','고객 확인 없이 해결로 만들기','RESOLVED');
  exception when others then v_r := true; end;
  perform public._assert(v_r, '처음부터 RESOLVED 로 만들어 넣을 수 없다');
end $t$;

delete from public.issue where code in ('T-1001','T-BAD','T-BYPASS','T-BYPASS2');

do $t$ begin raise notice ''; raise notice '전부 통과했습니다.'; end $t$;
