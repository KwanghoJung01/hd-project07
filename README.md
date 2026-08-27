# Field-Insight MVP-1

> 🌐 **배포 페이지: [https://aebonlee.github.io/hd-project07/](https://aebonlee.github.io/hd-project07/)** · 저장소: https://github.com/aebonlee/hd-project07

> 🗄️ **Supabase 를 붙이려면 → [`SUPABASE-설정.md`](SUPABASE-설정.md)**
> 데이터베이스는 **수강생 본인 계정**에 만듭니다. 계정 만들기부터 확인까지 단계별로 적어 두었습니다.


> **한 줄 정의**: 현장 사용자가 전문용어 없이 현상을 설명하면 AI가 상황별 정보요건을 스스로 정해 **판단을 바꿀 질문 3개 이내**로 Issue를 정형화하고, 전문가가 근거 점프와 AI 보조 분석으로 **확정원인·조치·근거·재발방지 4필드** 결론을 내려 고객 언어로 승인·회신하며, **고객이 해결을 확인한 사례만 Knowledge로 축적**하는 플랫폼.

- 기획: 정광호 (생성형 AI 업무자동화 전문가과정 — Field-Insight 시스템 개발계획서)
- 범위: **MVP-1** — 정비 Domain · 전체 루프 1회전 + **2차 고도화(현장 입력)**: 음성 녹음·실시간 STT·이미지/영상 첨부 (MVP-2/3 선반영)
- 아키텍처: **Phase 1** — 브라우저 + 로컬 JavaScript + **Mock AI Rule Engine** + LocalStorage/IndexedDB (기본 경로는 외부 AI/LLM API 호출 없음 — STT 정밀·비전 분석은 사용자가 키를 입력한 경우에만 선택 동작)

---

## 1. 실행 방법

별도 빌드·서버·외부 라이브러리가 필요 없습니다.

1. `app/index.html` 을 브라우저(Chrome 권장)로 엽니다.
2. 상단 **[시드 데모]** 버튼을 누르면 기획서 15장 시나리오(ISSUE #1024)가 **IN_REVIEW** 상태로 로드되어 전문가 흐름을 바로 체험할 수 있습니다.
3. **[접수자] / [전문가]** 토글로 화면 모드를 전환합니다(역할은 계정 분리가 아니라 `user.roles[]` + 모드 토글). 사용자는 **Phase 1 범위로 데모 사용자 1명(김현장, reporter+expert)만 하드코딩**되어 있으며, 다중 사용자/인증은 Phase 2(서버·DB 교체) 범위입니다.
4. 접수자 모드의 **[+ 새 이슈 접수]** 로 전체 루프(접수→판단→회신→해결확인→Knowledge 후보)를 처음부터 돌릴 수 있습니다.
5. **[초기화]** 버튼은 LocalStorage 데이터를 삭제합니다.

> 모바일 우선 UI: 현장 사용자는 장갑을 끼고 작업하므로 모든 버튼의 터치 영역을 48px 이상으로 설계했습니다.

## 2. 현장 입력 사용법 (2차 고도화 — 음성·이미지·영상)

위험한 현장에서 화면 응시와 타이핑을 최소화하기 위한 입력 방식입니다.

| 기능 | 사용법 | 비고 |
|---|---|---|
| 🎤 음성 접수 | C-01 상단 **[음성으로 접수]** (64px 대형 버튼) → 말하기 → **[■ 녹음 끝내기]** | 녹음 중에는 어두운 오버레이 + 진행 시간만 표시(화면 응시 최소화). 녹음 여러 개 첨부 가능 |
| 자동 텍스트 변환(STT) | 기본: **Web Speech API** — 말하는 즉시 텍스트 입력란에 자동 삽입 | **PC 크롬/엣지 + HTTPS + 네트워크 필요**. **스마트폰(특히 iOS)은 라이브 전사 대신 "녹음 첨부 + 직접 입력"** 으로 자동 전환(마이크 동시 점유 회피). `http://` LAN 주소로 열면 브라우저가 마이크를 차단하므로 `https://` 정식 주소로 접속 |
| Whisper 전사(선택) | **[⚙ 설정]**(전문가) → STT 엔진 'Whisper' + API 키 입력 → 녹음 종료 후 파일 업로드 전사 | 키는 이 브라우저 localStorage 에만 저장. 세그먼트 타임스탬프 포함. webspeech 를 골라도 이 기기가 라이브 전사 불가면 이 경로로 자동 폴백 |
| 📷/🎬 이미지·영상 첨부 | C-01 의 [사진 첨부]/[영상 첨부] — 모바일은 카메라 바로 촬영 | **영상 50MB 제한**(초과 시 안내). 원본은 IndexedDB 에 불변 보존, 이슈에는 참조만(DP-1) |
| AI 분석(선택) | **[⚙ 설정]**(전문가) → 제공사 **`Gemini / Claude / OpenAI`** + API 키 입력 → 접수 시 이미지·영상 프레임(최대 3장) 분석 | Gemini 선택 시 모델 `gemini-2.5-flash-lite / 2.5-flash / 3.6-flash` 중 선택(+직접 입력). 결과는 E-03 "미디어 분석" 섹션. **키가 없으면 완전 오프라인 규칙 엔진**. 무료 한도 초과(429)는 "일일 소진 / 잠시 몰림"으로 구분해 안내하고 접수는 규칙 엔진으로 계속 |
| 음성 근거 점프 | 전문가 E-02 에서 음성 유래 필드의 근거 클릭 → 해당 **전사 세그먼트부터 오디오 재생** + 구간 하이라이트 | transcript = `{text, start_ms, end_ms}` (원문 13장 스키마, word-timestamp 의 세그먼트 근사) |

> **브라우저 저장 용량 안내**: 첨부 미디어는 브라우저 IndexedDB 에 저장됩니다. 허용 용량은 브라우저·디스크 여유에 따라 다르며(보통 수백 MB 이상), 기기를 바꾸면 미디어는 이관되지 않습니다(Phase 2 서버 저장 전환 지점). 방식 비교·보존 정책 논의는 [docs/현장입력_고도화_검토의견.md](docs/현장입력_고도화_검토의견.md) 참고.

## 3. 데모 시나리오 워크스루 (ISSUE #1024)

기획서 15장 End-to-End 시나리오가 그대로 재현됩니다.

| 단계 | 화면 | 내용 |
|---|---|---|
| 1. 접수 | C-01 | `"붐을 내리고 오른쪽으로 돌면 가끔 덜컹거립니다."` 입력 + 보유장비에서 **HX220A · SN 3421 · 3,410h** 선택(MNT-12 자동 획득 — 질문 예산 미소모) |
| 2. 정보요건 판단 | (엔진) | Intent=정비/이상현상 → 추출: 현상 ✓ 조건 ✓ 작업 ✓ 빈도 △ / DecisionImpact 상위 3 = **재현성 · 예열 상태 · 정비 이력** |
| 3. 최소 질문 | C-02 | "언제 발생?" → **가끔** / "시동 직후에도?" → **시동 직후** / "1개월 내 정비 이력?" → **없음** (진행 표시 1/3, 모든 질문에 [모르겠음]) |
| 4. 선택적 확인 | C-03 | 빈도만 confidence 0.6 → ⚠ 해당 항목만 강조 → [맞아요] → **[접수하기]** → ISSUE #1024 생성 |
| 5. 전문가 검토 | E-01/02 | My Queue에서 진입(IN_REVIEW), 정형화 필드 옆 근거 링크 클릭 → 고객 원문 해당 구간 하이라이트 |
| 6. AI 분석 | E-03 | 판정 **B(유사 사례 존재)**: Case #0832(87%) · Manual 4-2 · 한계(유압 온도·선회 압력 미확보) 명시 |
| 7. 결론 확정 | E-04 | 자유 서술 → [AI 초안 생성] → 확정원인 **선회 유압 계통/선회 모터 릴리프 밸브(SW-HYD-0412)** · 조치(안내) · 근거(Case #0832+Manual 4-2+전문가 경험) · 재발방지(동절기 예열 절차 안내) |
| 8. 회신 승인 | E-05 | 전문가 원본 vs AI 고객용 재작성 나란히 → **[승인 후 발송]** → ANSWERED |
| 9. 해결 확인 | C-05 | 고객 **[해결됨]** → RESOLVED → 원인 확정+승인 사례만 **KNOWLEDGE_READY**(지식 승격 후보) |

## 4. MVP-1 범위와 FR 매핑

| FR | 요구사항 | 구현 위치 |
|---|---|---|
| FR-01 | 입력(MVP-1은 텍스트만) | `app` C-01 |
| FR-02 | 장비 식별 자동 획득(보유장비 선택) | C-01, `MNT-12` |
| FR-03 | 원본과 AI 해석 분리 저장(DP-1) | `issue.user_input`(불변) vs `issue.collected` |
| FR-04 | Intent 분류(8개 도메인) | `engine/intent.js` + `schema/domains.json` |
| FR-05 | 안전 위험 감지 → 수집 중단 + 긴급 경고 | `engine/intent.js`, 안전 분기 화면 |
| FR-06 | Domain별 정보요건 동적 선택 | `schema/maintenance.requirements.json` scenarios + `engine/gap.js` |
| FR-07 | Information Gap 분석(필요−확보) | `engine/gap.js` |
| FR-08 | DecisionImpact 질문 ≤3개·선택지형·[모르겠음] | `engine/question.js` |
| FR-09 | 선택적 확인 — 저신뢰 최대 2개 강조 | `engine/confidence.js` + C-03 |
| FR-10 | 접수 시점 Issue 확정 | `app/app.js` `submitIssue()` |
| FR-12/13 | 근거 기반 AI 분석 · A/B/C/D 4상태 | `engine/mockai.js` + E-03 |
| FR-14 | 필드 단위 원본 근거 점프(evidence_ref) | E-02 (텍스트 char offset 하이라이트) |
| FR-15 | My Queue(진행중/정보대기 레인 분리) | E-01 |
| FR-17 | 구조화 결론 4필드(계통·부품 코드) | E-04 + `schema/parts.master.json` |
| FR-20 | 기술 언어 → 고객 언어 재작성 | `engine/mockai.js` 치환 템플릿 |
| FR-21 | 발송 전 전문가 승인 게이트 | E-05 |
| FR-22 | 진행 상태 알림 | `issue.notifications[]` + C-04 타임라인 |
| FR-23 | 해결 확인 [해결됨/해결 안 됨/다시 질문] | C-05 |
| FR-24 | REOPEN(동일 Issue 이력 유지 재검토) | `REOPENED→IN_REVIEW`, `reopen_count` |
| FR-25 | Version/Audit Trail(append-only) | `issue.audit[]` (`statemachine.appendAudit`) |
| FR-11/16/18/19/26/27 | MVP-2/4 항목 | Mock/구조만(유사사례는 Mock 저장소, Knowledge 게이트는 후보 등록까지) |

Phase 1에서도 실제 스키마로 구현한 4가지(원문 16장): **`evidence_ref` · `confidence` · Issue 상태머신 · 회신 루프** — 모두 포함.

## 5. 아키텍처

```text
schema/  ─ 데이터 우선(SSOT). 코드가 아니라 데이터로 도메인을 정의
 ├─ domains.json                  8개 도메인(정비 active) + 안전 키워드
 ├─ maintenance.requirements.json 정비 MNT-01~12 매트릭스(판별력·획득가능성·선택지·추출 규칙·시나리오)
 ├─ parts.master.json             계통 10종·부품 24종 코드 마스터(자유 텍스트 금지의 근거)
 └─ undetermined_reasons.json     원인 미확정 사유 코드 4종

engine/  ─ 순수 JS(UMD) — 브라우저·Node 양쪽에서 동일하게 동작(단위 테스트 대상)
 ├─ intent.js       키워드 규칙 Intent 분류 + 안전 감지
 ├─ gap.js          시나리오 선택·필드 추출(evidence_ref)·Gap 분석
 ├─ question.js     DecisionImpact = 판별력 × 획득가능성 × 미확보도 → 질문 ≤3
 ├─ confidence.js   출처 기반 신뢰도(uttered .95/answered .99/system 1.0/inferred .6/default .4/ambiguous .5)
 ├─ statemachine.js 상태머신(불법 전이 throw) + append-only 감사 이력
 ├─ mockai.js       ★ LLM 어댑터 인터페이스 + Mock Rule Engine 구현
 ├─ media.js        (2차) 파일 검증(영상 50MB)·transcript 병합·char 매핑·프레임 시점 계산
 ├─ stt.js          (2차) Web Speech 실시간 전사(세그먼트 ms) + Whisper 업로드 어댑터 · 모바일/보안컨텍스트 가드
 └─ aivision.js     (2차) 선택 정밀 모드 AI 어댑터 — Gemini / Claude / OpenAI (키 입력 시에만), 429 한도 구분 처리

app/     ─ 단일 페이지(C-01~05 / E-01~05, 역할 모드 토글, LocalStorage + IndexedDB 미디어 스토어)
seed/    ─ ISSUE #1024 시나리오 시드(엔진으로 생성 — 데이터 박제 아님)
tests/   ─ 단위(node) + E2E(Playwright)
```

### Phase 2 교체 지점

| 교체 대상 | 현재(Phase 1) | Phase 2 | 방법 |
|---|---|---|---|
| AI | `mockai.createMockAdapter()` (규칙/템플릿) | Local LLM | `analyzeIssue / draftStructuredOpinion / rewriteForCustomer` 3개 메서드를 가진 어댑터로 교체. 화면·상태머신·스키마는 그대로 |
| 저장소 | `app/app.js` 의 `Store` (LocalStorage) | **Supabase — 구현 완료** | `app/fi-supabase.js`. `Store` 인터페이스는 그대로 두고 저장 위치만 바뀐다 |
| 입력 | 텍스트 char offset + **음성 세그먼트 ms**(2차 구현) | word-level timestamp | `transcript[]` 스키마 동일 — 로컬 Whisper 등으로 세그먼트를 word 로 상세화만 하면 됨 |
| 유사사례 | `mockai.js` 의 `MOCK_CASES` | Local Vector DB | 검증(RESOLVED) 사례만 색인(DP-8) |

## 5-1. 여러 사람이 실제로 주고받게 하기 (서버 모드)

기본은 **데모 모드**다 — 이 브라우저에만 저장되고, 혼자 전체 흐름을 돌려 볼 수 있다.
그런데 이 앱의 목적은 **현장 → 전문가 → 고객**으로 이슈가 넘어가는 것이라,
자료가 각자 브라우저에만 있으면 넘길 상대가 없다.

`app/config.js` 에 본인 Supabase 값을 넣으면 **서버 모드**가 된다.
절차는 저장소 루트의 [`SUPABASE-설정.md`](SUPABASE-설정.md) 에 단계별로 있다.
화면 맨 위 띠가 지금 어느 모드인지 늘 알려 준다.

서버 모드에서 **접수자는 로그인하지 않는다** — 초기 화면이 바로 접수 화면이고, Supabase
**익명 세션**으로 이슈를 서버에 넣는다(계정 없이). 자기가 넣은 이슈만 이 기기에서 다시 볼 수 있다.
**전문가/관리자만** 헤더의 `[전문가]` 버튼 → 이메일·비밀번호 로그인으로 전체 큐를 이어받는다.
접수자 익명 세션이 동작하려면 Supabase 대시보드에서 **Anonymous sign-ins** 를 켜야 한다(SUPABASE-설정.md 7.1).
RLS 는 접수자에게 자기 이슈만, 전문가에게 전체를 보인다.

### 담는 방식 — 컬럼과 jsonb 를 겹쳐 쓴다

이슈 하나는 화면에서 깊게 중첩된 객체다(원본·질문·결론·회신·감사이력…).
표 여러 개로 완전히 쪼개면 화면 코드 1,586줄을 다시 써야 한다. 그래서 둘을 겹친다.

| | 어디에 | 왜 |
|---|---|---|
| 상태·접수자·장비·코드 | **진짜 컬럼** | RLS 와 상태 관문이 이 값들을 보고 판단한다 |
| 나머지 전부 | `issue.structured` (jsonb) | 화면 코드는 받은 그대로 쓰고 아무것도 잃지 않는다 |

**상태의 정본은 컬럼이다.** `structured` 안에도 status 가 들어 있지만 그것은 흔적일 뿐이라,
읽어 올 때 컬럼 값으로 덮어쓴다. 둘을 다 믿으면 어긋난 순간 어느 쪽이 맞는지 알 수 없다.

### 상태를 한 칸씩 올리는 이유

DB 의 `can_transition()` 은 **한 걸음씩만** 허용한다(건너뛰기 방지).
그런데 화면은 접수 한 번에 `DRAFT → SUBMITTED → ASSIGNED` 까지 간다.
그래서 어댑터가 목표까지의 길을 찾아 **한 칸씩** UPDATE 한다.
한 번에 밀어 넣으면 트리거가 막고, 막는 것이 맞다.

저장 순서도 정해져 있다 — **① 이슈 행 → ② 결론·회신·해결확인 → ③ 상태 올리기.**
순서를 바꾸면 "결론이 없으면 ANSWERED 로 갈 수 없습니다" 로 막힌다.

### 상태 정의는 한 곳에서만 고친다

`engine/statemachine.js` 가 정본이고, `supabase/schema.sql` 의
`<<<GENERATED:STATES>>>` 구간은 거기서 굽는다.

```bash
node tools/build-sql-states.js          # 다시 굽는다
node tools/build-sql-states.js --check  # 어긋나 있으면 1 로 죽는다
```

두 곳에 손으로 적어 두었더니 실제로 갈라져 있었다 —
화면은 12개 상태로 도는데 DB 는 화면에 없는 이름 6개만 허용해서,
그대로 연결했으면 **첫 접수부터 저장이 통째로 실패**하고 화면에는 이유가 안 보였을 것이다.
`npm test`(단위)가 이 어긋남을 잡는다.

### DB 가 직접 지키는 것

화면에서만 막으면 다른 경로로 들어온 값이 그대로 통과한다. 그래서 트리거에도 둔다.

- `ANSWERED` — 결론 4필드 + **승인된** 회신이 있어야 한다
- `RESOLVED` — **고객의 해결 확인**이 있어야 한다 (전문가가 혼자 닫을 수 없다)
- Knowledge — 고객이 확인한 사례만 들어온다
- 관문은 `INSERT` 에도 걸려 있다. `UPDATE` 에만 걸면 처음부터 `ANSWERED` 로
  만들어 넣는 길이 열려 결론도 회신도 없는 "답변 완료" 가 생긴다.

### 첨부 미디어 — 비공개 버킷 + 서명 주소

현장이 찍은 사진·녹음이 브라우저(IndexedDB)에만 있으면 **전문가에게 넘어가지 않는다.**
서버 모드에서는 원본을 Supabase Storage 의 `field-insight` 버킷으로 올리고,
참조를 `attachment` 표에 남긴다.

- **비공개 버킷**이다. 주소를 알아도 그냥은 못 받고, 볼 때마다 **한 시간짜리 서명 주소**를
  발급받아 `<img>`/`<audio>` 에 물린다. 현장 사진에 사업장·설비가 찍히므로 공개로 두면 안 된다.
- 이 기기에 원본이 있으면 IndexedDB Blob 을 그대로 쓰고, **없으면(남이 올린 것) 서버에서 받아 온다.**
  이 갈래가 없으면 전문가 화면에서 현장 사진이 통째로 비어 보인다.
- **지우는 정책은 두지 않았다.** 원본 미디어는 판단의 근거다 — 화면에서 지울 수 있으면
  사후에 근거가 사라진다.
- 첨부 하나가 실패해도 **이슈 저장은 살린다.** 전문가가 남의 이슈를 고칠 때 그 기기에는
  첨부 원본이 없는데, 그것 때문에 저장이 통째로 죽으면 안 된다.

### 역할

`app_user.roles` 에 없는 모드는 **버튼째 감춘다.**
열어 두면 화면은 보이는데 저장만 막혀 무엇이 잘못됐는지 알 수 없다.
계정을 만들고 역할을 등록하는 SQL 은 `SUPABASE-설정.md` 7장에 있다.

## 6. 스키마 확장 방법 — Domain 추가

1. `schema/domains.json` 의 해당 도메인에 `active: true` 와 `keywords`, `schema_ref` 를 채운다.
2. `schema/<domain>.requirements.json` 을 만든다 — `maintenance.requirements.json` 과 동일 구조:
   - `requirements[]`: `requirement_id · label · discriminative_weight(판별력, 정수 사전 정의) · obtainability(상/중/하/자동) · ask_policy(ask/expert_check/auto_acquire) · options[] · extract[](키워드 추출 규칙)`
   - `scenarios[]`: 시나리오별 `requirement_ids` 집합 + `trigger_keywords` (질문 Tree가 시나리오마다 달라지는 지점)
3. `node tools/build-schema-bundle.js` 로 `app/schema.bundle.js` 를 재생성한다(원본 JSON이 항상 SSOT — 번들 동기화는 단위 테스트가 검증).
4. 엔진 코드는 수정할 필요가 없다 — intent/gap/question/confidence 는 전부 스키마 데이터 구동이다.

## 7. 테스트

```bash
# 단위 테스트: DecisionImpact 수기 검증, confidence 테이블, 상태머신 전이/불법 전이,
# Intent/안전 감지, Gap 분석(15장 Step 2 재현), 질문 3개 제한·'하' 제외, Mock AI(빈/널 입력 가드 포함), 스키마 동기화,
# (2차) 파일 검증·프레임 계산·transcript char 매핑·STT 세그먼트 타이밍·Whisper 파서·비전 어댑터
node tests/unit.test.js

# 서버 모드 통합 (진짜 PostgreSQL + 진짜 schema.sql + 고치지 않은 fi-supabase.js)
./scripts/sqltest/run-server-test.sh
# 단위는 어댑터 계산만, SQL 하네스는 DB 규칙만 본다. 둘이 맞물리는 지점
# (컬럼 이름·저장 순서·상태 경로·첨부 업로드)은 여기서만 잡힌다.

# E2E (Playwright/Chromium, 18단계): 시드 재현 + 15장 전체 루프 1회전(텍스트 경로)
#   + (2차) 가짜 마이크 녹음/정지, STT 자동 삽입(주입형 SpeechRecognition), 이미지 첨부(setInputFiles),
#     IndexedDB 저장 검증, 음성 세그먼트 근거 점프
node tests/e2e.test.js
# playwright 미설치 시: npm i playwright 후 실행하거나 PLAYWRIGHT_DIR=<node_modules/playwright 경로> 지정
```

## 8. 설계 원칙 반영 요약 (DP-1~9)

- **DP-1/2** 원본 불변 + 모든 정형화 값에 `evidence_ref`(input_id + char offset). 근거를 못 대는 값은 "미확보"로 남김
- **DP-3** 질문은 예산 — DecisionImpact 상위 최대 3개만
- **DP-4** 전체 요약 승인 대신 저신뢰 상위 2개만 강조 확인
- **DP-5** Mock AI도 A/B/C/D로 "자료 없음/정보 부족"을 명시
- **DP-6** 전문가는 자유 서술 → AI 4필드 초안 → 확인·수정만
- **DP-7** 회신 루프(승인 발송→알림→해결 확인)가 핵심 루프로 구현됨
- **DP-8** [해결됨] + 원인 확정 + 승인 사례만 KNOWLEDGE_READY
- **DP-9** MERGED/STALE/CLOSED_UNVERIFIED 는 어느 상태에서든 진입 가능한 "종결 상태"(삭제 아님)
