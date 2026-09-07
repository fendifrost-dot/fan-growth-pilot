#!/usr/bin/env bash
# Apply daily-ops migrations against local PostgreSQL with rollback on failure.
# Usage: bash scripts/test-daily-ops-migrations.sh
# Env:
#   AGH_MIGTEST_USE_SUDO=1  — wrap via `sudo -u postgres` (default for local unix socket)
#   PGHOST / PGUSER / PGPASSWORD — for CI Postgres service (set AGH_MIGTEST_USE_SUDO=0)
#   AGH_MIGTEST_REQUIRE_LIVE_PREFLIGHT=1 — abort unless live orphan report is explicitly acknowledged
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB_NAME="agh_daily_ops_migtest"
export PGUSER="${PGUSER:-postgres}"
export PGHOST="${PGHOST:-/var/run/postgresql}"

if [[ -z "${AGH_MIGTEST_USE_SUDO:-}" ]]; then
  if [[ "${PGHOST}" == /var/run/postgresql* ]] || [[ "${PGHOST}" == /tmp* ]]; then
    AGH_MIGTEST_USE_SUDO=1
  else
    AGH_MIGTEST_USE_SUDO=0
  fi
fi
export AGH_MIGTEST_USE_SUDO

psql_admin() {
  if [[ "${AGH_MIGTEST_USE_SUDO}" == "1" ]]; then
    sudo -u postgres psql -v ON_ERROR_STOP=1 "$@"
  else
    psql -v ON_ERROR_STOP=1 "$@"
  fi
}

run_sql() {
  if [[ "${AGH_MIGTEST_USE_SUDO}" == "1" ]]; then
    sudo -u postgres psql -v ON_ERROR_STOP=1 -d "${DB_NAME}" -t -A "$@"
  else
    psql -v ON_ERROR_STOP=1 -d "${DB_NAME}" -t -A "$@"
  fi
}

run_sql_pretty() {
  if [[ "${AGH_MIGTEST_USE_SUDO}" == "1" ]]; then
    sudo -u postgres psql -v ON_ERROR_STOP=1 -d "${DB_NAME}" "$@"
  else
    psql -v ON_ERROR_STOP=1 -d "${DB_NAME}" "$@"
  fi
}

assert_eq() {
  local label="$1" actual="$2" expected="$3"
  if [[ "${actual}" != "${expected}" ]]; then
    echo "FAIL assert: ${label}: got '${actual}' expected '${expected}'"
    psql_admin -c "DROP DATABASE IF EXISTS ${DB_NAME};" || true
    exit 1
  fi
  echo "OK assert: ${label}=${expected}"
}

echo "==> Starting PostgreSQL if needed (sudo=${AGH_MIGTEST_USE_SUDO})"
if [[ "${AGH_MIGTEST_USE_SUDO}" == "1" ]]; then
  sudo pg_ctlcluster 16 main start 2>/dev/null || sudo service postgresql start 2>/dev/null || true
  sleep 1
fi

echo "==> Recreating database ${DB_NAME}"
psql_admin -c "DROP DATABASE IF EXISTS ${DB_NAME};"
psql_admin -c "CREATE DATABASE ${DB_NAME};"

echo "==> Minimal prerequisite schema (stubs for FKs)"
run_sql_pretty <<'SQL'
create extension if not exists pgcrypto;

do $$ begin
  create role authenticated;
exception when duplicate_object then null; end $$;
do $$ begin
  create role service_role;
exception when duplicate_object then null; end $$;
do $$ begin
  create role anon;
exception when duplicate_object then null; end $$;

create schema if not exists auth;
create table if not exists auth.users (id uuid primary key default gen_random_uuid());
create or replace function auth.uid()
returns uuid
language sql
stable
as $$ select null::uuid $$;

create or replace function public.has_role(uid uuid, role text)
returns boolean language sql stable as $$ select true $$;

create table public.tracks (
  id uuid primary key default gen_random_uuid(),
  name text,
  approved_song_dna_version_id uuid,
  sync_eligible boolean default false,
  has_sample text
);

create table public.song_dna_versions (
  id uuid primary key default gen_random_uuid(),
  track_id uuid not null references public.tracks(id),
  approval_state text not null default 'draft',
  approved_lanes text[] default '{}',
  excluded_lanes text[] default '{}',
  short_pitch text,
  primary_genre text
);

create table public.playlist_targets (
  playlist_id text primary key,
  playlist_name text,
  lane text,
  verification_status text default 'unverified'
);

create table public.discovery_profiles (
  id uuid primary key default gen_random_uuid(),
  profile_key text unique not null,
  label text not null,
  is_active boolean default true,
  approval_status text default 'pending_fendi_review'
);
SQL

apply_with_rollback() {
  local file="$1"
  echo "==> Applying $(basename "$file")"
  if ! run_sql_pretty -f "$file"; then
    echo "FAIL: $(basename "$file") — rolling back by dropping database"
    psql_admin -c "DROP DATABASE IF EXISTS ${DB_NAME};" || true
    exit 1
  fi
}

apply_with_rollback "$ROOT/supabase/migrations/20260907000000_daily_ops_multichannel_sync_intake.sql"
apply_with_rollback "$ROOT/supabase/migrations/20260907010000_daily_ops_pr19_security_amendment.sql"
apply_with_rollback "$ROOT/supabase/migrations/20260907020000_daily_ops_operational_chain.sql"
apply_with_rollback "$ROOT/supabase/migrations/20260907030000_daily_ops_rpc_hardening.sql"
apply_with_rollback "$ROOT/supabase/migrations/20260907120000_mcp_playlist_discovery_oauth.sql"
apply_with_rollback "$ROOT/supabase/migrations/20260907130000_mcp_oauth_token_lifecycle.sql"

echo "==> MCP OAuth tables exist with actor check"
OAUTH_TBL=$(run_sql -c "select count(*) from information_schema.tables where table_schema='public' and table_name='agh_mcp_oauth_tokens';")
assert_eq "mcp_oauth_tokens_table" "${OAUTH_TBL}" "1"
OAUTH_CHECK=$(run_sql -c "select pg_get_constraintdef(oid) from pg_constraint where conrelid='public.agh_mcp_oauth_tokens'::regclass and contype='c' limit 1;")
echo "OK constraint: ${OAUTH_CHECK}"
REFRESH_COL=$(run_sql -c "select count(*) from information_schema.columns where table_schema='public' and table_name='agh_mcp_oauth_tokens' and column_name='refresh_expires_at';")
assert_eq "mcp_oauth_refresh_expires_at" "${REFRESH_COL}" "1"
CLEANUP_FN=$(run_sql -c "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='agh_mcp_oauth_cleanup_expired';")
assert_eq "mcp_oauth_cleanup_fn" "${CLEANUP_FN}" "1"

echo "==> Preflight orphan report (empty fixture DB — not production proof)"
run_sql_pretty -c "select * from public.agh_daily_ops_fk_preflight();"
echo "NOTE: empty migtest DB cannot prove production FK orphans are clean."
echo "      Before live apply, run agh_daily_ops_fk_preflight() against production via Lovable SQL Editor."
if [[ "${AGH_MIGTEST_REQUIRE_LIVE_PREFLIGHT:-0}" == "1" ]]; then
  if [[ "${AGH_MIGTEST_LIVE_PREFLIGHT_ACK:-}" != "orphans_inspected" ]]; then
    echo "FAIL: AGH_MIGTEST_REQUIRE_LIVE_PREFLIGHT=1 requires AGH_MIGTEST_LIVE_PREFLIGHT_ACK=orphans_inspected"
    echo "      (abort: fixture DB is not a live-data preflight)"
    psql_admin -c "DROP DATABASE IF EXISTS ${DB_NAME};" || true
    exit 1
  fi
fi

echo "==> Seed batch for RPC assertions"
run_sql_pretty <<'SQL'
insert into public.tracks (id, name) values ('11111111-1111-1111-1111-111111111111', 'Test Track');
insert into public.song_dna_versions (id, track_id, approval_state, approved_lanes, short_pitch)
values ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'approved', array['rap_general'], 'pitch');
update public.tracks set approved_song_dna_version_id = '22222222-2222-2222-2222-222222222222'
 where id = '11111111-1111-1111-1111-111111111111';

insert into public.agh_handoff_batches (id, batch_kind, queue_state, track_id, song_dna_version_id, discovered_by, discovered_by_label)
values ('33333333-3333-3333-3333-333333333333', 'playlist', 'CLAUDE_BATCH_READY',
        '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
        'claude', 'claude');
SQL

echo "==> Happy-path RPC must return ok=true"
OK1=$(run_sql -c "select public.advance_agh_handoff_batch(
  '33333333-3333-3333-3333-333333333333',
  'CLAUDE_BATCH_READY',
  'CLAUDE_PLAYLIST_COMPLETE',
  '{\"drafted_by\":\"claude\",\"drafted_by_label\":\"claude\"}'::jsonb
) ->> 'ok';")
assert_eq "happy_path_ok" "${OK1}" "true"

echo "==> Race / wrong expected state must return code=conflict"
CONFLICT=$(run_sql -c "select public.advance_agh_handoff_batch(
  '33333333-3333-3333-3333-333333333333',
  'CLAUDE_BATCH_READY',
  'CLAUDE_PLAYLIST_COMPLETE',
  '{}'::jsonb
) ->> 'code';")
assert_eq "race_conflict_code" "${CONFLICT}" "conflict"

echo "==> Illegal transition skip must fail inside PostgreSQL"
ILLEGAL=$(run_sql -c "select public.advance_agh_handoff_batch(
  '33333333-3333-3333-3333-333333333333',
  'CLAUDE_PLAYLIST_COMPLETE',
  'APPROVED_FOR_SEND',
  '{}'::jsonb
) ->> 'code';")
assert_eq "illegal_skip_code" "${ILLEGAL}" "illegal_transition"

echo "==> Legal next step after COMPLETE"
OK2=$(run_sql -c "select public.advance_agh_handoff_batch(
  '33333333-3333-3333-3333-333333333333',
  'CLAUDE_PLAYLIST_COMPLETE',
  'AWAITING_GROK_REVIEW',
  '{\"drafted_by\":\"claude\"}'::jsonb
) ->> 'ok';")
assert_eq "awaiting_grok_ok" "${OK2}" "true"

echo "==> authenticated must NOT execute SECURITY DEFINER RPC"
# Grant CONNECT so SET ROLE authenticated can run; EXECUTE must still be denied.
run_sql_pretty -c "grant usage on schema public to authenticated;" >/dev/null
run_sql_pretty -c "grant select on public.agh_handoff_batches to authenticated;" >/dev/null || true
set +e
DENIED_OUT=$(run_sql_pretty -c "set role authenticated; select public.advance_agh_handoff_batch(
  '33333333-3333-3333-3333-333333333333',
  'AWAITING_GROK_REVIEW',
  'GROK_REVIEWED',
  '{}'::jsonb
);" 2>&1)
DENIED_RC=$?
set -e
if [[ ${DENIED_RC} -eq 0 ]]; then
  echo "FAIL: authenticated was able to execute advance_agh_handoff_batch"
  echo "${DENIED_OUT}"
  psql_admin -c "DROP DATABASE IF EXISTS ${DB_NAME};" || true
  exit 1
fi
if ! echo "${DENIED_OUT}" | grep -qiE 'permission denied|must be owner|not granted'; then
  echo "FAIL: expected permission denied for authenticated RPC; got:"
  echo "${DENIED_OUT}"
  psql_admin -c "DROP DATABASE IF EXISTS ${DB_NAME};" || true
  exit 1
fi
echo "OK assert: authenticated_rpc_denied"

echo "==> PASS: daily-ops migrations applied + authoritative RPC assertions verified"
