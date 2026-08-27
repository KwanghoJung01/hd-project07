# Supabase 설정 안내 — Field-Insight — 현장 이슈 정형화

> `hd-project07` · 기획: 정광호 · 생성형 AI 업무자동화 전문가과정 1차수

## 이 문서를 읽기 전에 — 계정은 "본인 것"입니다

이 저장소는 강사 GitHub 에 있지만, **데이터베이스는 수강생 본인 Supabase 계정에 만듭니다.**
강사 계정이나 회사 계정에 연결하는 것이 아닙니다.

그래서 이렇게 되어 있습니다.

| | |
|---|---|
| 표 이름에 접두사가 없다 | 본인 프로젝트라 남과 섞일 일이 없기 때문입니다. (한 프로젝트에 다른 앱을 함께 올릴 생각이면 이름이 겹치는지 먼저 보세요) |
| 저장소 어디에도 접속 정보가 없다 | 각자 값이 다르기 때문입니다. `app/config.js` 가 비어 있는 채로 들어 있고, 그 파일을 본인 값으로 채우는 것이 이 문서의 목적입니다. |
| 회사 데이터를 넣지 않습니다 | 교육용 계정입니다. 사내 자료는 사내 승인 절차를 거친 뒤에 다루세요. |

**지금 이 저장소 상태: 바로 쓸 수 있음.** 화면이 이미 Supabase 를 부르도록 되어 있습니다. 아래 절차대로 **값 두 개만 채우면** 서버 모드로 바뀝니다.

---

## 0. 안 해도 되나요?

됩니다. 설정하지 않으면 **데모 모드**로 돌아갑니다 — 화면과 계산은 똑같고 저장 위치만 브라우저가 됩니다.

- 데모 모드로 두면: 한 사람이 전체 흐름을 혼자 돌려 보는 것까지 됩니다. 실제 인계는 안 됩니다.
- 서버 모드가 필요한 이유: **현장 → 전문가 → 고객**으로 넘어가는 흐름이라 여러 사람이 같은 이슈를 이어받습니다. 브라우저에만 저장하면 넘길 상대가 없습니다.

화면 맨 위에 지금 어느 모드인지 **띠**로 적혀 있습니다. 헷갈리면 그것을 보세요.

---

## 1. Supabase 계정과 프로젝트 만들기

1. <https://supabase.com> → **Start your project** → GitHub 계정으로 로그인하면 가장 빠릅니다.
2. **New project** 를 누르고 다음을 정합니다.

   | 항목 | 무엇을 넣나 |
   |---|---|
   | Name | 아무 이름 (예: `hd-project07`) |
   | Database Password | **따로 적어 두세요.** 나중에 화면에서 다시 보여주지 않습니다. 이 앱에서는 쓰지 않지만 DB 에 직접 붙을 때 필요합니다. |
   | Region | `Northeast Asia (Seoul)` — 가까울수록 빠릅니다 |

3. 만들어지는 데 1~2분 걸립니다. 초록불이 들어올 때까지 기다립니다.

> **무료 플랜에서 알아 둘 것**
> 활성 프로젝트 수에 제한이 있고, **일정 기간 아무도 접속하지 않으면 프로젝트가 일시정지**됩니다.
> 정지돼도 데이터는 남아 있고 대시보드에서 다시 켜면 됩니다. 수업 뒤 한동안 안 쓰다가
> "갑자기 연결이 안 된다"면 이것부터 확인하세요. (플랜 조건은 바뀔 수 있습니다)

---

## 2. 표 만들기 — `supabase/schema.sql` 실행

1. 왼쪽 메뉴에서 **SQL Editor** 를 엽니다.
2. **New query** 를 누릅니다.
3. 이 저장소의 **`supabase/schema.sql` 전체를 복사해 붙여 넣습니다.** (일부만 넣지 마세요)
4. **Run** (또는 `Ctrl`/`Cmd` + `Enter`).
5. 아래에 `Success. No rows returned` 이 뜨면 된 것입니다.

> **여러 번 실행해도 안전합니다.** `if not exists` / `drop ... if exists` 를 앞에 붙여 두었습니다.
> 중간에 오류가 나서 고친 뒤 처음부터 다시 돌려도 데이터가 지워지지 않습니다.

### 잘 들어갔는지 확인

같은 SQL Editor 에 아래를 붙여 넣고 실행하면 만들어진 표가 나옵니다.

```sql
select table_name
  from information_schema.tables
 where table_schema = 'public'
 order by 1;
```

다음 11개가 보이면 정상입니다.

```
admin
app_user
attachment
conclusion
issue
knowledge
log
question
reply
resolution
workspace
```

조회용 뷰도 함께 만들어집니다 — `issue_view`, `knowledge_candidates`, `status_summary`

---

## 3. 접속 정보 두 개 복사하기

왼쪽 아래 **Project Settings**(톱니) → **API Keys** 로 들어갑니다.
(이전 화면에서는 **Settings → API** 였습니다. 둘 중 보이는 쪽으로 가면 됩니다.)

| 화면에 적힌 이름 | 어디에 쓰나 |
|---|---|
| **Project URL** — `https://…….supabase.co` | `SUPABASE_URL` |
| **`anon` `public`** 키 (최근 만든 프로젝트에서는 **publishable** 로 표시될 수 있습니다) | `SUPABASE_ANON_KEY` |

> ### ⚠️ `service_role` / `secret` 키는 절대 쓰지 마세요
> 바로 아래 칸에 있어서 자주 잘못 가져갑니다. 그 키는 **접근제어(RLS)를 통째로 무시**합니다.
> 브라우저에 넣으면 주소창을 볼 줄 아는 누구나 전체 데이터를 읽고 지울 수 있습니다.
>
> 반대로 `anon` 키는 **공개해도 되는 키**입니다. 실제 차단은 키가 아니라
> `supabase/schema.sql` 에 들어 있는 RLS 정책이 합니다.

---

## 4. `app/config.js` 에 넣기

저장소의 **`app/config.js`** 를 열어 두 줄을 채우고, `USE_SUPABASE` 를 `true` 로 바꿉니다.

```js
root.APP_CONFIG = {
  SUPABASE_URL:      'https://여기에본인주소.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOi……',   // anon / public 키
  USE_SUPABASE:      true,
};
```

> **커밋하기 전에 잠깐 켜 보고 싶다면** 주소 뒤에 `?supabase=1` 을 붙이면 됩니다.
> 예: `https://aebonlee.github.io/hd-project07/app/?supabase=1`
> (이 방법도 값 두 개는 채워 두어야 동작합니다)

---

## 5. 됐는지 확인하기

1. **https://aebonlee.github.io/hd-project07/app/** 를 새로고침합니다.
2. 화면 맨 위 띠를 봅니다.

   | 띠 색 | 뜻 | 할 일 |
   |---|---|---|
   | 초록 — "서버에 연결됨" | 성공 | 없음 |
   | 노랑 — "이 브라우저에만 저장됩니다" | 아직 데모 모드 | 아래 6장 |
   | 노랑 + "(연결 실패: …)" | 값은 넣었는데 연결이 안 됨 | 괄호 안 문구를 6장에서 찾으세요 |

3. 화면에서 한 건 저장한 뒤 Supabase 대시보드 **Table Editor** 에서 그 행이 보이면 확실합니다.

---

## 6. 안 될 때 — 문구별 원인

| 화면/콘솔에 나오는 말 | 원인 | 고치는 법 |
|---|---|---|
| `relation "…" does not exist` | 표가 없습니다 | 2장을 아직 안 했거나, `schema.sql` 을 일부만 붙여 넣었습니다 |
| `Could not find the table … in the schema cache` | 위와 같습니다 | 스키마를 올린 직후라면 1분 뒤 새로고침 |
| `Invalid API key` | 키를 잘못 가져왔습니다 | `anon` / `publishable` 인지 확인 (`service_role` 아님) |
| `Failed to fetch` / 아무 반응 없음 | 주소가 틀렸거나 프로젝트가 일시정지 | Project URL 을 다시 복사, 대시보드에서 정지 여부 확인 |
| `new row violates row-level security policy` | 정책이 막았습니다 | 스키마를 다시 실행했는지 확인(7장). 전문가 작업이면 로그인 상태인지 확인 |
| `익명 접속 불가 … Anonymous sign-ins 를 켜세요` | 익명 로그인이 꺼져 있음 | 7.1 — Authentication → Anonymous sign-ins 활성화 |
| 띠가 계속 노랑 | `USE_SUPABASE` 가 `false` | 4장에서 `true` 로 바꿨는지 확인 |
| 저장은 되는데 전문가에게 안 보임 | 익명 로그인 꺼짐(데모로 저장 중) | 7.1 활성화 후 새로고침 |
| 접수자인데 남의 이슈까지 보임 | 스키마 재실행 전 | `supabase/schema.sql` 다시 실행(익명 RLS 반영) |

그래도 모르겠으면 **`F12` → Console** 을 열어 빨간 줄을 그대로 복사해 오세요. 거기에 원인이 적혀 있습니다.

---

## 7. 로그인 — 접수자는 계정 없이, 전문가만 로그인

이 앱은 **접속자에 따라 보이는 것이 달라집니다.**

| 역할 | 로그인 | 무엇을 하나 |
|---|---|---|
| **접수자**(현장) | **필요 없음** — 초기 화면이 바로 접수 화면 | 이슈 접수, 이 기기에서 내 이슈 진행 상황 확인 |
| **전문가/관리자** | 이메일·비밀번호 | 헤더의 **[전문가]** 버튼 → 로그인 → 전체 큐를 이어받아 처리 |

접수자는 **익명 세션**으로 서버에 이슈를 넣습니다(계정 없이). 그래서 접수 내용이 전문가에게 넘어갑니다.

### 7.1 익명 로그인을 켜세요 (필수)

대시보드 **Authentication → Sign In / Providers → Anonymous sign-ins → Enable** 를 켭니다.
켜지 않으면 초기 화면에서 *"익명 접속 불가"* 띠가 뜨고, 접수가 이 브라우저에만 저장됩니다(전문가에게 안 넘어감).

> 익명 사용자가 무한정 쌓이는 것이 걱정되면, 같은 화면의 **rate limit** 과
> **Auth → Settings** 의 익명 사용자 정리 옵션을 함께 조정하세요.

### 7.2 전문가 계정 만들기

대시보드 **Authentication → Users → Add user → Create new user**. 시험용이면 **Auto Confirm User** 를 켜세요.
이메일·비밀번호로 로그인하므로 `AUTH_EMAIL_DOMAIN` 은 건드릴 필요가 없습니다.

### 역할을 반드시 등록하세요

전문가 계정에 역할을 안 넣으면 **로그인은 되는데 큐가 비어 보입니다.**
(화면 위 띠가 "역할이 없습니다" 라고 알려 줍니다). 접수자는 계정이 없으므로 등록할 것이 없습니다.

```sql
-- 현장 접수자
insert into public.app_user (user_id, name, email, roles)
select id, '홍길동', email, array['reporter']
  from auth.users where email = 'field@example.com'
on conflict (user_id) do update set roles = excluded.roles;

-- 전문가
insert into public.app_user (user_id, name, email, roles)
select id, '김전문', email, array['expert']
  from auth.users where email = 'expert@example.com'
on conflict (user_id) do update set roles = excluded.roles;
```

### 이 앱의 진짜 확인 방법

**한 브라우저는 그냥(접수자), 다른 브라우저/시크릿 창은 전문가 로그인** 으로 엽니다.
접수자 쪽에서 이슈를 올리고, 전문가 쪽 **[전문가] → 로그인** 후 My Queue 에 그 이슈가
보이면 된 것입니다. 접수자 쪽에서는 자기가 올린 이슈만 보여야 정상입니다(전문가 결론·다른 사람 이슈는 안 보임).

> ⚠ 스키마를 고쳤으므로 **`supabase/schema.sql` 을 SQL Editor 에서 다시 실행**하세요.
> (익명 접수자용 RLS 정책 `is_anon_user()` · `is_staff()` 가 추가됐습니다. 재실행 안전합니다.)

---

## 8. (선택) 사진·영상 AI 분석 — 서버 공용 키

개별 사용자가 각자 API 키를 넣지 않고, **관리자가 한 번만 넣으면 모두가 바로** 쓰게 하는 방법입니다.
키는 브라우저에 나가지 않고 Edge Function 안에만 있습니다. (무료 티어로 충분)

### 8.1 함수 배포

1. 대시보드 → **Edge Functions** → **Deploy a new function**
2. 이름 `ai-vision`
3. `supabase/functions/ai-vision/index.ts` 내용을 **그대로 붙여넣기** → **Deploy**
   (CLI 를 쓴다면 `supabase functions deploy ai-vision`)

### 8.2 키 넣기 (Secret)

대시보드 → Edge Functions → **ai-vision → Secrets** (또는 Project Settings → Edge Functions → Secrets):

| 이름 | 값 |
|---|---|
| `GEMINI_API_KEY` | Google AI Studio 키 (**Field-Insight 전용 키 권장** — 다른 프로젝트와 나눠 쓰면 일일 한도 공유) |
| `GEMINI_MODEL` (선택) | `gemini-3.6-flash` (비우면 이 값이 기본) |

### 8.3 켜기

`app/config.js` 에서 `AI_PROXY: true` 로 바꾸고 커밋
(커밋 없이 잠깐 확인만 하려면 주소 뒤에 `?ai=1`).

### 확인

접수 화면에서 **사진을 첨부**하면 상단에 "🔍 첨부한 사진·영상을 AI가 함께 분석합니다" 가 뜨고,
`다음(내용 분석)` 을 누르면 서버가 분석합니다. 함수·키가 없으면 자동으로 오프라인 규칙 엔진으로 내려갑니다(접수는 항상 됨). 무료 한도를 넘으면 "오늘 한도 소진" 안내 후 규칙 엔진으로 계속됩니다.

> `GEMINI_API_KEY` 는 커밋 금지 — Secret 에만. `config.js` 의 `AI_PROXY` 는 켜기/끄기 스위치일 뿐이라 커밋해도 됩니다.

---

## 9. 커밋해도 되는 것, 안 되는 것

| | |
|---|---|
| ✅ `SUPABASE_URL`, `anon` 키 | 공개해도 되는 값입니다. 브라우저 화면에 어차피 들어갑니다 |
| ❌ `service_role` / `secret` 키 | 절대 안 됩니다 |
| ❌ OpenAI·Claude·Solar API 키 | 절대 안 됩니다 |
| ❌ 사내 실제 데이터 | 교육용 계정입니다 |

> **한 번 커밋한 키는 지워도 남습니다.** 파일에서 지우고 다시 커밋해도 이전 커밋에 그대로 들어 있어 누구나 꺼내 볼 수 있습니다.
> 실수로 올렸다면 **그 키를 폐기하고 새로 발급**하는 것 말고는 방법이 없습니다.

---

## 9. 되돌리기

- **데모 모드로 돌아가기** — `app/config.js` 에서 `USE_SUPABASE: false`.
- **표만 지우고 다시 만들기** — SQL Editor 에서 `drop table if exists app_user ,issue ,question cascade;` 뒤 `schema.sql` 을 다시 실행합니다.
 (표 이름은 위 2장 목록 참고)
- **프로젝트째 지우기** — Project Settings → General 맨 아래. **되돌릴 수 없습니다.**

---

막히면 수업에서 화면 그대로 들고 오세요. 어디서 멈췄는지 보면 대부분 1분입니다.
