#!/usr/bin/env bash
# ============================================================================
# 서버 모드 통합 테스트 — 진짜 PostgreSQL 에 진짜 schema.sql 을 올리고
# app/fi-supabase.js 를 **고치지 않은 채로** 태워 한 바퀴 돌린다.
#
#   ./scripts/sqltest/run-server-test.sh
#
# 단위 테스트는 어댑터의 계산만, SQL 하네스는 DB 규칙만 본다.
# 둘이 맞물리는 지점(컬럼 이름·저장 순서·상태 경로)은 여기서만 잡힌다.
# 임시 클러스터를 쓰고 끝나면 지운다 — 기존 PostgreSQL 설치에 영향이 없다.
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PGBIN="${PGBIN:-}"
if [ -z "$PGBIN" ]; then
  for c in /usr/local/opt/postgresql@17/bin /opt/homebrew/opt/postgresql@17/bin \
           /usr/local/opt/postgresql@16/bin /opt/homebrew/opt/postgresql@16/bin; do
    [ -x "$c/initdb" ] && PGBIN="$c" && break
  done
fi
if [ -z "$PGBIN" ] && command -v initdb >/dev/null 2>&1; then
  PGBIN="$(dirname "$(command -v initdb)")"
fi
if [ -z "$PGBIN" ]; then
  echo "PostgreSQL 을 찾지 못했습니다. 'brew install postgresql@17' 후 다시 실행하세요." >&2
  exit 1
fi

TMP="$(mktemp -d)"; PGDATA="$TMP/data"; PGSOCK="$TMP/sock"; mkdir -p "$PGSOCK"
cleanup() { "$PGBIN/pg_ctl" -D "$PGDATA" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

echo "임시 PostgreSQL 준비 중…"
"$PGBIN/initdb" -D "$PGDATA" -U postgres --auth=trust >/dev/null
"$PGBIN/pg_ctl" -D "$PGDATA" -o "-k $PGSOCK -h '' -c listen_addresses=''" -w start >/dev/null
"$PGBIN/createdb" -h "$PGSOCK" -U postgres sqltest

PSQL=("$PGBIN/psql" -h "$PGSOCK" -U postgres -d sqltest -v ON_ERROR_STOP=1 -q)
echo "① Supabase 환경 스텁"
"${PSQL[@]}" -f "$ROOT/scripts/sqltest/00_supabase_stub.local.sql"
echo "② schema.sql 적용"
"${PSQL[@]}" -f "$ROOT/supabase/schema.sql"

echo "③ 어댑터를 실제 DB 에 태운다"
FI_PSQL="$PGBIN/psql" FI_PGSOCK="$PGSOCK" node "$ROOT/tests/server.test.js"
