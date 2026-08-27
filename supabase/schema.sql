-- ============================================================================
-- hd-project07 — Field-Insight (현장 이슈 접수 → 전문가 판단 → 회신 → Knowledge)
-- Supabase(Postgres) 운영 스키마 + RLS · 재실행 안전
--
--  이 스키마는 **수강생 본인의 Supabase 프로젝트**에 올리는 것을 전제로 합니다.
--  프로젝트가 본인 것이라 테이블 이름에 접두사를 붙이지 않았습니다.
--  (여러 앱을 한 프로젝트에 몰아 쓸 계획이면 이름 충돌을 먼저 확인하세요.)
--
--  이 시스템의 규칙 두 가지를 DB 가 직접 지킵니다.
--   ① 상태는 정해진 순서로만 넘어간다 (접수 → 검토 → 회신 → 해결확인)
--   ② **고객이 해결을 확인한 사례만** Knowledge 로 넘어간다
--  화면에서만 막으면 다른 경로로 들어온 값이 그대로 통과합니다.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. 테이블
-- ----------------------------------------------------------------------------

create table if not exists public.app_user (
  user_id    uuid primary key,
  name       text not null,
  email      text,
  -- 한 사람이 접수자이면서 전문가일 수 있다 (기획서의 user.roles[] 그대로)
  roles      text[] not null default array['reporter']::text[],
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  constraint app_user_roles_valid
    check (roles <@ array['reporter','expert','approver','admin']::text[]
           and coalesce(array_length(roles, 1), 0) > 0)
);

-- 이슈 — 상태 기계의 주체
create table if not exists public.issue (
  id            bigint generated always as identity primary key,
  code          text unique,                      -- 'ISSUE #1024'
  domain        text not null default '정비',
  title         text not null,
  raw_text      text not null,                    -- 현장 사용자가 쓴 원문(전문용어 없이)
  structured    jsonb not null default '{}'::jsonb, -- AI 가 정형화한 결과
  -- 허용 상태 목록은 아래 GENERATED 구간이 제약으로 붙인다.
  -- 여기에 손으로 적으면 engine/statemachine.js 와 갈라진다 (실제로 갈라져 있었다).
  status        text not null default 'DRAFT',
  reporter_id   uuid,
  -- 접수자가 스스로 적은 이름·이메일(계정 아님). 전문가 회신·아웃룩 메일 초안에 쓴다.
  reporter_name  text,
  reporter_email text,
  expert_id     uuid,
  equipment     text,
  site          text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  resolved_at   timestamptz,
  -- 해결 확인이 되었으면 시각이 있어야 한다. 둘이 어긋나면 Knowledge 판정이 흔들린다.
  -- 해결 확인이 되었으면 시각이 있어야 한다. 둘이 어긋나면 Knowledge 판정이 흔들린다.
  -- 해결로 보는 상태는 RESOLVED 와 그 뒤(KNOWLEDGE_READY) 두 가지다.
  constraint issue_resolved_consistency
    check ((status in ('RESOLVED','KNOWLEDGE_READY')) = (resolved_at is not null))
);
create index if not exists issue_status_idx on public.issue (status, created_at desc);
-- 이미 만들어진 표에도 붙인다 (create table if not exists 는 컬럼을 더해 주지 않는다)
alter table public.issue add column if not exists reporter_name  text;
alter table public.issue add column if not exists reporter_email text;

-- AI 가 던지는 질문 — 판단을 바꿀 질문 3개 이내
create table if not exists public.question (
  id         bigint generated always as identity primary key,
  issue_id   bigint not null references public.issue(id) on delete cascade,
  seq        int not null check (seq between 1 and 3),
  question   text not null,
  answer     text,
  asked_at   timestamptz not null default now(),
  constraint question_uniq unique (issue_id, seq)
);

-- 전문가 결론 — 확정원인·조치·근거·재발방지 4필드
create table if not exists public.conclusion (
  id            bigint generated always as identity primary key,
  issue_id      bigint not null references public.issue(id) on delete cascade,
  root_cause    text not null,
  action        text not null,
  evidence      text not null,
  prevention    text not null,
  expert_id     uuid default auth.uid(),
  concluded_at  timestamptz not null default now(),
  -- 이슈 하나에 결론 하나. 여러 개면 어느 것이 회신 근거인지 알 수 없다.
  constraint conclusion_one unique (issue_id),
  -- 4필드가 모두 채워져야 결론이다. 빈 문자열도 막는다.
  constraint conclusion_filled check (
    btrim(root_cause) <> '' and btrim(action) <> ''
    and btrim(evidence) <> '' and btrim(prevention) <> '')
);

-- 고객 회신 (고객 언어로 변환 + 승인)
create table if not exists public.reply (
  id           bigint generated always as identity primary key,
  issue_id     bigint not null references public.issue(id) on delete cascade,
  body         text not null,
  approved_by  uuid,
  approved_at  timestamptz,
  sent_at      timestamptz,
  -- 승인 없이 나갈 수 없다
  constraint reply_approved_before_sent
    check (sent_at is null or approved_at is not null),
  constraint reply_one unique (issue_id)
);

-- 고객 해결 확인
create table if not exists public.resolution (
  id           bigint generated always as identity primary key,
  issue_id     bigint not null references public.issue(id) on delete cascade,
  confirmed    boolean not null,
  comment      text,
  confirmed_at timestamptz not null default now(),
  constraint resolution_one unique (issue_id)
);

-- Knowledge — 고객이 해결을 확인한 사례만 들어온다 (트리거가 강제)
create table if not exists public.knowledge (
  id           bigint generated always as identity primary key,
  issue_id     bigint not null references public.issue(id) on delete cascade,
  title        text not null,
  symptom      text,
  root_cause   text not null,
  action       text not null,
  prevention   text,
  tags         text[] default '{}'::text[],
  created_at   timestamptz not null default now(),
  constraint knowledge_one unique (issue_id)
);
create index if not exists knowledge_tags_idx on public.knowledge using gin (tags);

create table if not exists public.attachment (
  id         bigint generated always as identity primary key,
  issue_id   bigint not null references public.issue(id) on delete cascade,
  kind       text not null check (kind in ('image','video','audio','file')),
  file_name  text not null,
  storage_path text,
  size_bytes bigint,
  created_at timestamptz not null default now(),
  -- 같은 첨부를 다시 올려도 행이 늘어나면 안 된다.
  -- upsert 가 기댈 제약이 여기 없으면 **저장이 조용히 실패**한다(§3.7).
  constraint attachment_uniq unique (issue_id, file_name)
);

create table if not exists public.log (
  id        bigint generated always as identity primary key,
  ran_at    timestamptz not null default now(),
  kind      text not null,
  issue_id  bigint,
  detail    text,
  actor     uuid default auth.uid()
);
create index if not exists log_ran_at_idx on public.log (ran_at desc);

create table if not exists public.admin (
  user_id uuid primary key, email text, created_at timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- 2. 함수 · 상태 기계
-- ----------------------------------------------------------------------------

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $fn$
  select exists (select 1 from public.admin a where a.user_id = auth.uid())
      or exists (select 1 from public.app_user u
                  where u.user_id = auth.uid() and 'admin' = any(u.roles));
$fn$;

create or replace function public.has_role(p_role text)
returns boolean language sql stable security definer set search_path = public as $fn$
  select exists (select 1 from public.app_user u
                  where u.user_id = auth.uid() and u.active and p_role = any(u.roles));
$fn$;

-- 익명 로그인(접수자)인지. anon 역할이 아니라 "익명 세션으로 로그인한 authenticated" 다.
-- 접수자는 계정 없이 이슈를 넣되, 자기가 넣은 것만 다시 볼 수 있어야 한다.
create or replace function public.is_anon_user()
returns boolean language sql stable set search_path = public as $fn$
  select coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false);
$fn$;

-- 전문가/관리자(정식 계정)인지 — 정책에서 반복되므로 묶어 둔다
create or replace function public.is_staff()
returns boolean language sql stable security definer set search_path = public as $fn$
  select public.is_admin() or public.has_role('expert') or public.has_role('approver');
$fn$;

/**
 * 상태 전이 규칙.
 *
 * 되돌리기(회신 → 검토)는 허용한다. 실무에서 전문가가 결론을 다시 잡는 일이 있다.
 * 다만 **건너뛰기는 막는다** — 접수 상태에서 바로 해결로 갈 수 없다.
 * 화면에서만 막으면 API 를 직접 부르는 순간 뚫린다.
 */
-- 기존에 만들어 둔 표에도 붙인다 (create table if not exists 는 제약을 더해 주지 않는다)
do $att$
begin
  if not exists (select 1 from pg_constraint where conname = 'attachment_uniq') then
    alter table public.attachment add constraint attachment_uniq unique (issue_id, file_name);
  end if;
end;
$att$;

-- <<<GENERATED:STATES:BEGIN>>>
-- ⚠ 이 구간은 engine/statemachine.js 에서 자동 생성됩니다. 손으로 고치지 마세요.
--    고칠 곳은 engine/statemachine.js 이고, 그다음
--    `node tools/build-sql-states.js` 를 돌리면 여기가 다시 구워집니다.
--    (어긋나면 `npm test` 가 잡습니다 — tests/unit.test.js)

alter table public.issue drop constraint if exists issue_status_valid;
alter table public.issue add constraint issue_status_valid
  check (status in ('DRAFT', 'SUBMITTED', 'ASSIGNED', 'IN_REVIEW', 'PENDING_FIELD', 'ANSWERED', 'RESOLVED', 'REOPENED', 'KNOWLEDGE_READY', 'MERGED', 'STALE', 'CLOSED_UNVERIFIED'));

create or replace function public.can_transition(p_from text, p_to text)
returns boolean language sql immutable set search_path = public as $fn$
  select case
    when p_from = p_to then true
    when p_to in ('MERGED', 'STALE', 'CLOSED_UNVERIFIED') then true   -- 어디서든 진입 가능
    when p_from = 'DRAFT' and p_to in ('SUBMITTED') then true
    when p_from = 'SUBMITTED' and p_to in ('ASSIGNED') then true
    when p_from = 'ASSIGNED' and p_to in ('IN_REVIEW') then true
    when p_from = 'IN_REVIEW' and p_to in ('PENDING_FIELD', 'ANSWERED') then true
    when p_from = 'PENDING_FIELD' and p_to in ('IN_REVIEW') then true
    when p_from = 'ANSWERED' and p_to in ('RESOLVED', 'REOPENED') then true
    when p_from = 'RESOLVED' and p_to in ('KNOWLEDGE_READY') then true
    when p_from = 'REOPENED' and p_to in ('IN_REVIEW') then true
    else false
  end;
$fn$;
-- <<<GENERATED:STATES:END>>>


create or replace function public.guard_transition()
returns trigger language plpgsql set search_path = public as $fn$
begin
  -- ── 전이 규칙 (UPDATE 일 때만) ─────────────────────────────────────
  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    if not public.can_transition(old.status, new.status) then
      raise exception '허용되지 않는 상태 전이입니다: % → %', old.status, new.status;
    end if;
  end if;

  -- ── 관문 (INSERT·UPDATE 양쪽) ──────────────────────────────────────
  --   ⚠ INSERT 에도 건다. UPDATE 에만 걸면 **처음부터 ANSWERED 로 만들어 넣는**
  --      길이 열려, 결론도 회신도 없이 "답변 완료"인 이슈가 생긴다.
  --   그래서 앱은 이슈를 먼저 넣고(초기 상태) → 결론·회신·확인을 넣고 →
  --   마지막에 상태를 올린다. 그 순서라야 관문이 실제로 지켜진다.
  if tg_op = 'INSERT' or new.status is distinct from old.status then

    -- ANSWERED = 전문가 결론이 나오고 고객 회신이 승인된 상태.
    -- 둘 중 하나라도 없으면 "답변이 갔다"고 말할 수 없다.
    if new.status = 'ANSWERED' then
      if not exists (select 1 from public.conclusion c where c.issue_id = new.id) then
        raise exception '결론(확정원인·조치·근거·재발방지)이 없으면 ANSWERED 로 갈 수 없습니다.';
      end if;
      if not exists (select 1 from public.reply r
                      where r.issue_id = new.id and r.approved_at is not null) then
        raise exception '승인된 회신이 없으면 ANSWERED 로 갈 수 없습니다.';
      end if;
    end if;

    -- RESOLVED = **고객이 해결을 확인한** 상태. 전문가가 혼자 닫을 수 없다.
    if new.status in ('RESOLVED','KNOWLEDGE_READY')
       and not exists (select 1 from public.resolution r
                        where r.issue_id = new.id and r.confirmed) then
      raise exception '고객의 해결 확인이 없으면 % 로 갈 수 없습니다.', new.status;
    end if;
  end if;

  -- 해결 시각은 상태에서 따라 나온다 — 손으로 넣게 두면 둘이 어긋난다
  if new.status in ('RESOLVED','KNOWLEDGE_READY') then
    if new.resolved_at is null then new.resolved_at := now(); end if;
  else
    new.resolved_at := null;
  end if;

  new.updated_at := now();
  return new;
end;
$fn$;

drop trigger if exists issue_guard on public.issue;
-- INSERT 에도 건다. UPDATE 에만 걸면 **처음부터 ANSWERED 로 만들어 넣는** 길이 열려
-- 결론도 회신도 없이 "답변 완료"인 이슈가 생긴다.
create trigger issue_guard before insert or update on public.issue
  for each row execute function public.guard_transition();

/**
 * Knowledge 축적 규칙 — 기획서의 핵심 문장.
 * "고객이 해결을 확인한 사례만 Knowledge 로 축적한다."
 */
create or replace function public.guard_knowledge()
returns trigger language plpgsql set search_path = public as $fn$
declare v_ok boolean;
begin
  select coalesce(r.confirmed, false) and i.status in ('RESOLVED','KNOWLEDGE_READY')
    into v_ok
    from public.issue i
    left join public.resolution r on r.issue_id = i.id
   where i.id = new.issue_id;

  if not coalesce(v_ok, false) then
    raise exception '고객이 해결을 확인한 이슈만 Knowledge 로 축적할 수 있습니다 (issue_id=%)', new.issue_id;
  end if;
  return new;
end;
$fn$;

drop trigger if exists knowledge_guard on public.knowledge;
create trigger knowledge_guard before insert or update on public.knowledge
  for each row execute function public.guard_knowledge();

-- ----------------------------------------------------------------------------
-- 3. 뷰
-- ----------------------------------------------------------------------------

-- issue 테이블에 컬럼이 추가되면 `select i.*` 로 펼쳐지는 뷰의 컬럼 순서가 바뀌어
-- `create or replace view` 가 거부한다("cannot change name of view column").
-- 그래서 매번 먼저 떨어뜨린 뒤 다시 만든다 (의존 순서: candidates → issue_view).
drop view if exists public.knowledge_candidates;
drop view if exists public.issue_view;

-- ⚠ 뷰에는 `with (security_invoker = true)` 를 붙인다.
--   붙이지 않으면 뷰는 **만든 사람(postgres)의 권한**으로 돌아, 뷰를 읽을 수 있는
--   사람이 밑에 깔린 표의 RLS 를 통째로 지나친다. 표만 잠그고 뷰를 안 잠그면 헛일이다.
--   (hd-project03 에서 실제로 남의 업체 실사 결과가 뷰로 그대로 보였다.
--    tests/server.test.js 의 "업체는 보고서 뷰로도 남의 자료를 볼 수 없다" 가 잡는다)
--   security_invoker 는 PostgreSQL 15 부터. Supabase 는 15 이상이다.
create or replace view public.issue_view with (security_invoker = true) as
select i.*,
       (select count(*) from public.question q where q.issue_id = i.id) as question_count,
       (select count(*) from public.attachment a where a.issue_id = i.id) as attachment_count,
       c.root_cause, c.action, c.evidence, c.prevention,
       rp.approved_at is not null as reply_approved,
       rs.confirmed              as customer_confirmed,
       (k.id is not null)        as in_knowledge
from public.issue i
left join public.conclusion c  on c.issue_id  = i.id
left join public.reply rp      on rp.issue_id = i.id
left join public.resolution rs on rs.issue_id = i.id
left join public.knowledge k   on k.issue_id  = i.id;

-- Knowledge 후보 — 해결 확인은 됐는데 아직 안 올린 것
create or replace view public.knowledge_candidates with (security_invoker = true) as
select id, code, title, root_cause, action, prevention, resolved_at
from public.issue_view
where customer_confirmed is true and in_knowledge = false;

create or replace view public.status_summary with (security_invoker = true) as
select status, count(*) as cnt from public.issue group by status;

-- ----------------------------------------------------------------------------
-- 4. RLS
-- ----------------------------------------------------------------------------

alter table public.app_user       enable row level security;
alter table public.issue      enable row level security;
alter table public.question   enable row level security;
alter table public.conclusion enable row level security;
alter table public.reply      enable row level security;
alter table public.resolution enable row level security;
alter table public.knowledge  enable row level security;
alter table public.attachment enable row level security;
alter table public.log        enable row level security;
alter table public.admin      enable row level security;

-- 이슈 접근 규칙
--   · 전문가/관리자 : 전체 큐를 읽고 고친다
--   · 접수자(익명 세션) : **자기가 넣은 이슈만** 읽고, 넣을 때 자기 uid 를 reporter_id 로 찍는다
--   화면에서 아무리 막아도 API 를 직접 부르면 뚫리므로 여기서 잠근다.
drop policy if exists issue_read   on public.issue;
drop policy if exists issue_write  on public.issue;
drop policy if exists issue_update on public.issue;
drop policy if exists issue_delete on public.issue;
create policy issue_read   on public.issue for select to authenticated
  using (public.is_staff() or reporter_id = auth.uid());
create policy issue_write  on public.issue for insert to authenticated
  with check (
    public.is_staff()
    or (reporter_id = auth.uid())                 -- 익명 접수자: 반드시 자기 것으로 찍어야 통과
  );
create policy issue_update on public.issue for update to authenticated
  using (public.is_staff() or reporter_id = auth.uid())
  with check (public.is_staff() or reporter_id = auth.uid());
create policy issue_delete on public.issue for delete to authenticated
  using (public.is_admin());

-- 결론은 전문가만 (접수자는 읽지도 못한다 — 내부 판단 근거)
drop policy if exists conclusion_read   on public.conclusion;
drop policy if exists conclusion_write  on public.conclusion;
drop policy if exists conclusion_update on public.conclusion;
create policy conclusion_read   on public.conclusion for select to authenticated using (public.is_staff());
create policy conclusion_write  on public.conclusion for insert to authenticated
  with check (public.has_role('expert') or public.is_admin());
create policy conclusion_update on public.conclusion for update to authenticated
  using (public.has_role('expert') or public.is_admin())
  with check (public.has_role('expert') or public.is_admin());

-- 이슈에 매달린 부속 표(질문·회신·해결확인·첨부):
--   전문가/관리자는 전부, 접수자는 **자기 이슈의 것만**.
--   ⚠ format() 은 위치 지정자(%1$I)와 순서 지정자(%I)를 섞을 수 없다 → 전부 위치 지정.
do $rls$
declare t text;
declare own_clause text :=
  ' or exists (select 1 from public.issue i where i.id = %2$I.issue_id and i.reporter_id = auth.uid())';
begin
  foreach t in array array['question','reply','resolution','attachment']
  loop
    execute format('drop policy if exists %1$I on public.%2$I', t || '_read',   t);
    execute format('drop policy if exists %1$I on public.%2$I', t || '_write',  t);
    execute format('drop policy if exists %1$I on public.%2$I', t || '_update', t);
    execute format('drop policy if exists %1$I on public.%2$I', t || '_delete', t);
    execute format(
      'create policy %1$I on public.%2$I for select to authenticated using (public.is_staff()' || own_clause || ')',
      t || '_read', t);
    execute format(
      'create policy %1$I on public.%2$I for insert to authenticated with check (public.is_staff()' || own_clause || ')',
      t || '_write', t);
    execute format(
      'create policy %1$I on public.%2$I for update to authenticated using (public.is_staff()' || own_clause || ') with check (true)',
      t || '_update', t);
    execute format(
      'create policy %1$I on public.%2$I for delete to authenticated using (public.is_admin())',
      t || '_delete', t);
  end loop;
end;
$rls$;

-- Knowledge 는 검증된 재사용 사례 모음 — 민감 정보 아님. 전문가/관리자만 다룬다.
drop policy if exists knowledge_read   on public.knowledge;
drop policy if exists knowledge_write  on public.knowledge;
drop policy if exists knowledge_update on public.knowledge;
drop policy if exists knowledge_delete on public.knowledge;
create policy knowledge_read   on public.knowledge for select to authenticated using (public.is_staff());
create policy knowledge_write  on public.knowledge for insert to authenticated with check (public.is_staff());
create policy knowledge_update on public.knowledge for update to authenticated using (public.is_staff()) with check (public.is_staff());
create policy knowledge_delete on public.knowledge for delete to authenticated using (public.is_admin());

drop policy if exists app_user_read   on public.app_user;
drop policy if exists app_user_write  on public.app_user;
drop policy if exists app_user_update on public.app_user;
-- 직원 명단(이름·이메일·역할)은 접수자에게 보일 필요가 없다 → 전문가/관리자만.
--   (자기 행은 볼 수 있게 해 두면 loadMe 가 익명이 아닐 때 편하다)
create policy app_user_read   on public.app_user for select to authenticated
  using (public.is_staff() or user_id = auth.uid());
create policy app_user_write  on public.app_user for insert to authenticated with check (public.is_admin());
create policy app_user_update on public.app_user for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists log_read  on public.log;
drop policy if exists log_write on public.log;
create policy log_read  on public.log for select to authenticated using (public.is_staff());
create policy log_write on public.log for insert to authenticated with check (true);

drop policy if exists admin_read on public.admin;
create policy admin_read on public.admin for select to authenticated using (public.is_admin());

-- ----------------------------------------------------------------------------
-- 5. 함수 실행 권한 (§3.7)
-- ----------------------------------------------------------------------------

revoke all on function public.is_admin()                    from public, anon;
revoke all on function public.has_role(text)                from public, anon;
revoke all on function public.is_anon_user()                from public, anon;
revoke all on function public.is_staff()                    from public, anon;
revoke all on function public.can_transition(text, text)    from public, anon;
revoke all on function public.guard_transition()            from public, anon;
revoke all on function public.guard_knowledge()             from public, anon;

grant execute on function public.is_admin()                 to authenticated;
grant execute on function public.has_role(text)             to authenticated;
grant execute on function public.is_anon_user()             to authenticated;
grant execute on function public.is_staff()                 to authenticated;
grant execute on function public.can_transition(text, text) to authenticated;
grant execute on function public.guard_transition()         to authenticated;
grant execute on function public.guard_knowledge()          to authenticated;

-- ----------------------------------------------------------------------------
-- 끝. 사용자 등록:
--   insert into public.app_user (user_id, name, email, roles)
--   select id, '<이름>', email, array['reporter','expert'] from auth.users where email = '<이메일>'
--   on conflict (user_id) do nothing;
-- ----------------------------------------------------------------------------

-- ============================================================================
-- 첨부 미디어 저장소 (Supabase Storage)
--
--   현장이 찍은 사진·녹음이 브라우저(IndexedDB)에만 있으면 **전문가에게 넘어가지
--   않는다.** 이 앱은 넘기는 것이 목적이므로 원본을 서버에 둬야 한다.
--
--   비공개 버킷이다. 주소를 알아도 그냥은 못 받고, 로그인한 사람에게만
--   짧게 사는 서명 주소를 발급해 준다. 현장 사진에 사업장·설비가 찍히므로
--   공개 버킷으로 두면 안 된다.
--
--   ⚠ storage 스키마는 Supabase 에만 있다. 로컬 검증용 PostgreSQL 에는 없으므로
--     있을 때만 실행한다 — 없다고 스키마 전체가 멈추면 안 된다.
-- ============================================================================
do $storage$
begin
  if not exists (select 1 from pg_namespace where nspname = 'storage') then
    raise notice 'storage 스키마가 없어 첨부 저장소 설정을 건너뜁니다 (로컬 검증 환경).';
    return;
  end if;

  insert into storage.buckets (id, name, public)
  values ('field-insight', 'field-insight', false)
  on conflict (id) do update set public = false;   -- 실수로 공개로 바뀌어도 되돌린다

  execute $p$drop policy if exists fi_media_read on storage.objects$p$;
  execute $p$drop policy if exists fi_media_write on storage.objects$p$;
  execute $p$drop policy if exists fi_media_update on storage.objects$p$;

  -- 로그인한 사람은 읽고 올린다. 사내 정비 이슈라 서로 보는 것이 정상이다.
  execute $p$create policy fi_media_read on storage.objects
            for select to authenticated using (bucket_id = 'field-insight')$p$;
  execute $p$create policy fi_media_write on storage.objects
            for insert to authenticated with check (bucket_id = 'field-insight')$p$;
  -- 덮어쓰기(upsert)를 허용하되 지우는 정책은 두지 않는다.
  -- 원본 미디어는 판단의 근거다 — 화면에서 지울 수 있으면 사후에 근거가 사라진다.
  execute $p$create policy fi_media_update on storage.objects
            for update to authenticated
            using (bucket_id = 'field-insight') with check (bucket_id = 'field-insight')$p$;
end;
$storage$;

-- ===============================================================
-- 팀 공용 문서 (hd-docsync.js 용)
--
--   이 표 하나에 앱의 JSON 문서를 통째로 담아 팀원이 같은 것을 본다.
--   팀 내부 도구 — 어차피 서로 다 보는 화면 — 에만 쓴다.
--   사람마다 볼 범위가 달라야 하는 화면에는 쓸 수 없다(모두가 전부를 받게 된다).
-- ===============================================================

create table if not exists workspace (
  id         text primary key,
  doc        jsonb not null default '{}'::jsonb,
  -- 동시 편집으로 남의 작업이 조용히 사라지지 않게 하는 장치.
  -- 저장할 때 "내가 받아 온 버전"과 같은지 확인하고, 다르면 쓰지 않는다.
  version    bigint not null default 1,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);

alter table workspace enable row level security;

drop policy if exists workspace_read   on workspace;
drop policy if exists workspace_write  on workspace;
drop policy if exists workspace_update on workspace;
drop policy if exists workspace_delete on workspace;

-- 팀 내부 도구 — 전문가/관리자만. 익명 접수자에게는 팀 공용 문서를 열어 주지 않는다.
create policy workspace_read   on workspace for select to authenticated using (public.is_staff());
create policy workspace_write  on workspace for insert to authenticated with check (public.is_staff());
create policy workspace_update on workspace for update to authenticated using (public.is_staff()) with check (public.is_staff());
-- DELETE 정책은 두지 않는다. 팀 자료를 화면에서 통째로 지울 수 있으면 안 된다.
