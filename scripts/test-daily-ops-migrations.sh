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
  status text not null default 'active',
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

create table public.smart_links (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  title text,
  is_active boolean not null default true
);

create table public.playlist_targets (
  playlist_id text primary key,
  playlist_name text,
  lane text,
  verification_status text default 'unverified'
);

create table public.outreach_drafts (
  id uuid primary key default gen_random_uuid(),
  playlist_id text,
  track_id uuid,
  track_name text not null default 'unknown',
  song_dna_version_id uuid,
  channel text not null default 'email',
  status text not null default 'pending',
  generated_at timestamptz default now(),
  generated_by text,
  subject text,
  body text not null default '',
  recipient text,
  pitch_copy_source text,
  pitch_copy_hash text,
  metadata jsonb not null default '{}'::jsonb
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
apply_with_rollback "$ROOT/supabase/migrations/20260907140000_mcp_inventory_idempotency_oauth_atomic.sql"
apply_with_rollback "$ROOT/supabase/migrations/20260907150000_mcp_handoff_open_pair_diagnostics.sql"

echo "==> Open-pair diagnostics installed; guarded index not yet present"
DIAG_REPORT=$(run_sql -c "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='agh_mcp_handoff_open_pair_duplicate_report';")
assert_eq "diag_duplicate_report_fn" "${DIAG_REPORT}" "1"
DIAG_PLAN=$(run_sql -c "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='agh_mcp_handoff_open_pair_reconcile_plan';")
assert_eq "diag_reconcile_plan_fn" "${DIAG_PLAN}" "1"
OPEN_IDX_BEFORE=$(run_sql -c "select count(*) from pg_indexes where schemaname='public' and indexname='agh_handoff_records_open_pair_uidx';")
assert_eq "open_pair_index_absent_before_guard" "${OPEN_IDX_BEFORE}" "0"

echo "==> Seed duplicate open handoff pairs for guarded-migration refusal"
run_sql_pretty <<'SQL'
insert into public.tracks (id, name) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Dup Track')
  on conflict (id) do nothing;
insert into public.song_dna_versions (id, track_id, approval_state, approved_lanes, short_pitch)
values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'approved', array['rap_general'], 'pitch')
  on conflict (id) do nothing;
update public.tracks set approved_song_dna_version_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
 where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

insert into public.playlist_targets (playlist_id, lane, verification_status)
values ('pl-dup-target', 'rap_general', 'auto_verified')
on conflict (playlist_id) do nothing;

insert into public.agh_handoff_batches (id, batch_kind, queue_state, track_id, song_dna_version_id, discovered_by, discovered_by_label)
values
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'playlist', 'CLAUDE_BATCH_READY',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'claude', 'claude'),
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'playlist', 'CLAUDE_BATCH_READY',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'claude', 'claude');

insert into public.agh_handoff_records (
  id, batch_id, record_kind, queue_state, track_id, playlist_target_id,
  submission_channel, song_dna_version_id, packet
) values
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeee0001', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'playlist_target',
   'CLAUDE_BATCH_READY', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'pl-dup-target',
   'email', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '{}'::jsonb),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeee0002', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'playlist_target',
   'CLAUDE_BATCH_READY', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'pl-dup-target',
   'email', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '{}'::jsonb);
SQL

DUP_GROUPS=$(run_sql -c "select count(*) from public.agh_mcp_handoff_open_pair_duplicate_report();")
assert_eq "seeded_duplicate_groups" "${DUP_GROUPS}" "1"
PLAN_ROWS=$(run_sql -c "select count(*) from public.agh_mcp_handoff_open_pair_reconcile_plan();")
assert_eq "seeded_reconcile_plan_rows" "${PLAN_ROWS}" "1"

echo "==> Guarded 160000 must refuse while duplicates exist"
set +e
GUARD_OUT=$(run_sql_pretty -f "$ROOT/supabase/migrations/20260907160000_mcp_inventory_open_pair_guard_and_persist.sql" 2>&1)
GUARD_RC=$?
set -e
if [[ ${GUARD_RC} -eq 0 ]]; then
  echo "FAIL: expected 160000 to refuse when open-pair duplicates exist"
  echo "${GUARD_OUT}"
  psql_admin -c "DROP DATABASE IF EXISTS ${DB_NAME};" || true
  exit 1
fi
if ! echo "${GUARD_OUT}" | grep -qi 'PREFLIGHT FAIL'; then
  echo "FAIL: expected PREFLIGHT FAIL in guarded migration output"
  echo "${GUARD_OUT}"
  psql_admin -c "DROP DATABASE IF EXISTS ${DB_NAME};" || true
  exit 1
fi
echo "OK assert: guarded_migration_refused"

echo "==> Diagnostic functions remain callable after refusal"
AFTER_DUP=$(run_sql -c "select count(*) from public.agh_mcp_handoff_open_pair_duplicate_report();")
assert_eq "diag_callable_after_refusal_report" "${AFTER_DUP}" "1"
AFTER_PLAN=$(run_sql -c "select count(*) from public.agh_mcp_handoff_open_pair_reconcile_plan();")
assert_eq "diag_callable_after_refusal_plan" "${AFTER_PLAN}" "1"
OPEN_IDX_REFUSED=$(run_sql -c "select count(*) from pg_indexes where schemaname='public' and indexname='agh_handoff_records_open_pair_uidx';")
assert_eq "open_pair_index_still_absent" "${OPEN_IDX_REFUSED}" "0"
PERSIST_ABSENT=$(run_sql -c "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='agh_mcp_persist_playlist_inventory';")
assert_eq "persist_fn_absent_after_refusal" "${PERSIST_ABSENT}" "0"

echo "==> Reconcile fixture (mark later duplicate REJECTED_BY_GROK — deterministic)"
run_sql_pretty <<'SQL'
update public.agh_handoff_records r
   set queue_state = 'REJECTED_BY_GROK',
       rejection_reason = 'migtest_open_pair_reconcile',
       updated_at = now()
 where r.id in (select retire_record_id from public.agh_mcp_handoff_open_pair_reconcile_plan());
SQL
CLEAN_DUP=$(run_sql -c "select count(*) from public.agh_mcp_handoff_open_pair_duplicate_report();")
assert_eq "duplicates_cleared_after_reconcile" "${CLEAN_DUP}" "0"

echo "==> Rerun guarded 160000 successfully after reconcile"
apply_with_rollback "$ROOT/supabase/migrations/20260907160000_mcp_inventory_open_pair_guard_and_persist.sql"
OPEN_IDX_AFTER=$(run_sql -c "select count(*) from pg_indexes where schemaname='public' and indexname='agh_handoff_records_open_pair_uidx';")
assert_eq "open_pair_index_present_after_guard" "${OPEN_IDX_AFTER}" "1"
PERSIST_OK=$(run_sql -c "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='agh_mcp_persist_playlist_inventory';")
assert_eq "persist_fn_present_after_guard" "${PERSIST_OK}" "1"

echo "==> MCP OAuth tables exist with actor check"
OAUTH_TBL=$(run_sql -c "select count(*) from information_schema.tables where table_schema='public' and table_name='agh_mcp_oauth_tokens';")
assert_eq "mcp_oauth_tokens_table" "${OAUTH_TBL}" "1"
OAUTH_CHECK=$(run_sql -c "select pg_get_constraintdef(oid) from pg_constraint where conrelid='public.agh_mcp_oauth_tokens'::regclass and contype='c' limit 1;")
echo "OK constraint: ${OAUTH_CHECK}"
REFRESH_COL=$(run_sql -c "select count(*) from information_schema.columns where table_schema='public' and table_name='agh_mcp_oauth_tokens' and column_name='refresh_expires_at';")
assert_eq "mcp_oauth_refresh_expires_at" "${REFRESH_COL}" "1"
CLEANUP_FN=$(run_sql -c "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='agh_mcp_oauth_cleanup_expired';")
assert_eq "mcp_oauth_cleanup_fn" "${CLEANUP_FN}" "1"
IDEM_COL=$(run_sql -c "select count(*) from information_schema.columns where table_schema='public' and table_name='outreach_drafts' and column_name='ops_idempotency_key';")
assert_eq "outreach_drafts_ops_idempotency_key" "${IDEM_COL}" "1"
CONSUME_FN=$(run_sql -c "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='agh_mcp_consume_oauth_code';")
assert_eq "mcp_consume_oauth_code_fn" "${CONSUME_FN}" "1"
ROTATE_FN=$(run_sql -c "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='agh_mcp_rotate_oauth_refresh';")
assert_eq "mcp_rotate_oauth_refresh_fn" "${ROTATE_FN}" "1"

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

echo "==> Atomic OAuth consume: replay of same code fails; concurrent exchange → one success"
run_sql_pretty <<'SQL'
insert into public.agh_mcp_oauth_clients (client_id, client_secret_hash, client_name, redirect_uris)
values ('client-atomic', 'hash', 'test', array['https://claude.ai/api/mcp/auth_callback']);

insert into public.agh_mcp_oauth_codes (
  code_hash, client_id, redirect_uri, code_challenge, code_challenge_method,
  scope, authorized_by_user_id, expires_at
) values (
  'codehash-replay', 'client-atomic', 'https://claude.ai/api/mcp/auth_callback',
  'challenge', 'S256', 'playlist_discovery', null, now() + interval '10 minutes'
);
SQL

OK_CODE=$(run_sql -c "select public.agh_mcp_consume_oauth_code(
  'codehash-replay', 'client-atomic', 'https://claude.ai/api/mcp/auth_callback', 'challenge',
  'access-hash-1', 'refresh-hash-1', now() + interval '1 hour', now() + interval '30 days'
) ->> 'ok';")
assert_eq "oauth_consume_once_ok" "${OK_CODE}" "true"

REPLAY=$(run_sql -c "select public.agh_mcp_consume_oauth_code(
  'codehash-replay', 'client-atomic', 'https://claude.ai/api/mcp/auth_callback', 'challenge',
  'access-hash-2', 'refresh-hash-2', now() + interval '1 hour', now() + interval '30 days'
) ->> 'ok';")
assert_eq "oauth_consume_replay_fail" "${REPLAY}" "false"

TOK_COUNT=$(run_sql -c "select count(*) from public.agh_mcp_oauth_tokens where revoked_at is null;")
assert_eq "oauth_tokens_after_replay" "${TOK_COUNT}" "1"

echo "==> Concurrent code consume: exactly one success"
run_sql_pretty <<'SQL'
insert into public.agh_mcp_oauth_codes (
  code_hash, client_id, redirect_uri, code_challenge, code_challenge_method,
  scope, authorized_by_user_id, expires_at
) values (
  'codehash-race', 'client-atomic', 'https://claude.ai/api/mcp/auth_callback',
  'challenge', 'S256', 'playlist_discovery', null, now() + interval '10 minutes'
);
SQL

TMPA=$(mktemp)
TMPB=$(mktemp)
(
  run_sql -c "select public.agh_mcp_consume_oauth_code(
    'codehash-race', 'client-atomic', 'https://claude.ai/api/mcp/auth_callback', 'challenge',
    'access-race-a', 'refresh-race-a', now() + interval '1 hour', now() + interval '30 days'
  ) ->> 'ok';" >"$TMPA"
) &
(
  run_sql -c "select public.agh_mcp_consume_oauth_code(
    'codehash-race', 'client-atomic', 'https://claude.ai/api/mcp/auth_callback', 'challenge',
    'access-race-b', 'refresh-race-b', now() + interval '1 hour', now() + interval '30 days'
  ) ->> 'ok';" >"$TMPB"
) &
wait
A=$(tr -d '[:space:]' <"$TMPA")
B=$(tr -d '[:space:]' <"$TMPB")
rm -f "$TMPA" "$TMPB"
SUCCESS_N=0
[[ "${A}" == "true" ]] && SUCCESS_N=$((SUCCESS_N + 1))
[[ "${B}" == "true" ]] && SUCCESS_N=$((SUCCESS_N + 1))
assert_eq "oauth_concurrent_consume_one_success" "${SUCCESS_N}" "1"

echo "==> Concurrent refresh rotation: exactly one success; refresh_expires_at preserved"
run_sql_pretty <<'SQL'
delete from public.agh_mcp_oauth_tokens;
insert into public.agh_mcp_oauth_tokens (
  token_hash, refresh_token_hash, client_id, scope, actor_kind,
  expires_at, refresh_expires_at
) values (
  'tok-old', 'refresh-family', 'client-atomic', 'playlist_discovery', 'claude_playlist_discovery',
  now() + interval '1 hour', '2030-01-15T12:00:00Z'::timestamptz
);
SQL

PRESERVED=$(run_sql -c "select refresh_expires_at::text from public.agh_mcp_oauth_tokens where token_hash='tok-old';")

TMPA=$(mktemp)
TMPB=$(mktemp)
(
  run_sql -c "select public.agh_mcp_rotate_oauth_refresh(
    'refresh-family', 'client-atomic', 'access-rot-a', 'refresh-rot-a', now() + interval '1 hour'
  ) ->> 'ok';" >"$TMPA"
) &
(
  run_sql -c "select public.agh_mcp_rotate_oauth_refresh(
    'refresh-family', 'client-atomic', 'access-rot-b', 'refresh-rot-b', now() + interval '1 hour'
  ) ->> 'ok';" >"$TMPB"
) &
wait
A=$(tr -d '[:space:]' <"$TMPA")
B=$(tr -d '[:space:]' <"$TMPB")
rm -f "$TMPA" "$TMPB"
SUCCESS_N=0
[[ "${A}" == "true" ]] && SUCCESS_N=$((SUCCESS_N + 1))
[[ "${B}" == "true" ]] && SUCCESS_N=$((SUCCESS_N + 1))
assert_eq "oauth_concurrent_rotate_one_success" "${SUCCESS_N}" "1"

ACTIVE_N=$(run_sql -c "select count(*) from public.agh_mcp_oauth_tokens where revoked_at is null;")
assert_eq "oauth_rotate_active_tokens" "${ACTIVE_N}" "1"
NEW_EXP=$(run_sql -c "select refresh_expires_at::text from public.agh_mcp_oauth_tokens where revoked_at is null limit 1;")
assert_eq "oauth_rotate_preserves_refresh_expires_at" "${NEW_EXP}" "${PRESERVED}"

echo "==> Active idempotency index + open-pair preflight helpers"
ACTIVE_IDX=$(run_sql -c "select count(*) from pg_indexes where schemaname='public' and indexname='outreach_drafts_ops_idempotency_active_uidx';")
assert_eq "active_idempotency_index" "${ACTIVE_IDX}" "1"
OLD_IDX=$(run_sql -c "select count(*) from pg_indexes where schemaname='public' and indexname='outreach_drafts_ops_idempotency_uidx';")
assert_eq "old_idempotency_index_removed" "${OLD_IDX}" "0"
PREFLIGHT_FN=$(run_sql -c "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='agh_mcp_handoff_open_pair_duplicate_report';")
assert_eq "handoff_dup_preflight_fn" "${PREFLIGHT_FN}" "1"
PERSIST_FN=$(run_sql -c "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='agh_mcp_persist_playlist_inventory';")
assert_eq "persist_inventory_fn" "${PERSIST_FN}" "1"
DUP_N=$(run_sql -c "select count(*) from public.agh_mcp_handoff_open_pair_duplicate_report();")
assert_eq "live_dup_preflight_empty" "${DUP_N}" "0"

echo "==> Seed verified playlist targets for atomic inventory"
run_sql_pretty <<'SQL'
alter table public.playlist_targets
  add column if not exists path_verified boolean default false,
  add column if not exists contact_method text,
  add column if not exists submission_method text,
  add column if not exists curator_email text;

insert into public.playlist_targets (playlist_id, lane, verification_status, path_verified, contact_method, submission_method, curator_email)
values
  ('pl-inv-1', 'rap_general', 'auto_verified', true, 'email', 'email', 'a@test'),
  ('pl-inv-2', 'rap_general', 'auto_verified', true, 'email', 'email', 'b@test'),
  ('pl-inv-3', 'rap_general', 'auto_verified', true, 'email', 'email', 'c@test')
on conflict (playlist_id) do update set path_verified = excluded.path_verified;
SQL

echo "==> Partial handoff insert rollback (record 3 fails) leaves zero drafts/records/batches"
run_sql_pretty <<'SQL'
create or replace function public._agh_test_fail_third_handoff()
returns trigger language plpgsql as $$
begin
  if (select count(*) from public.agh_handoff_records where batch_id = new.batch_id) >= 2 then
    raise exception 'injected failure on third handoff insert';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_agh_test_fail_third on public.agh_handoff_records;
create trigger trg_agh_test_fail_third
  before insert on public.agh_handoff_records
  for each row execute function public._agh_test_fail_third_handoff();
SQL

set +e
FAIL_OUT=$(run_sql_pretty -c "select public.agh_mcp_persist_playlist_inventory(
  '11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222222',
  '{\"discovered_by\":\"claude_playlist_discovery\"}'::jsonb,
  '[
    {\"playlist_id\":\"pl-inv-1\",\"channel\":\"email\",\"idempotency_key\":\"11111111-1111-1111-1111-111111111111:pl-inv-1:email:22222222-2222-2222-2222-222222222222\",\"draft\":{\"body\":\"b1\",\"track_name\":\"Test Track\",\"subject\":\"s1\"},\"packet\":{\"packet_kind\":\"email_outreach_draft\"}},
    {\"playlist_id\":\"pl-inv-2\",\"channel\":\"email\",\"idempotency_key\":\"11111111-1111-1111-1111-111111111111:pl-inv-2:email:22222222-2222-2222-2222-222222222222\",\"draft\":{\"body\":\"b2\",\"track_name\":\"Test Track\",\"subject\":\"s2\"},\"packet\":{\"packet_kind\":\"email_outreach_draft\"}},
    {\"playlist_id\":\"pl-inv-3\",\"channel\":\"email\",\"idempotency_key\":\"11111111-1111-1111-1111-111111111111:pl-inv-3:email:22222222-2222-2222-2222-222222222222\",\"draft\":{\"body\":\"b3\",\"track_name\":\"Test Track\",\"subject\":\"s3\"},\"packet\":{\"packet_kind\":\"email_outreach_draft\"}}
  ]'::jsonb
);" 2>&1)
FAIL_RC=$?
set -e
if [[ ${FAIL_RC} -eq 0 ]]; then
  echo "FAIL: expected third-handoff failure to abort transaction"
  echo "${FAIL_OUT}"
  psql_admin -c "DROP DATABASE IF EXISTS ${DB_NAME};" || true
  exit 1
fi
echo "OK assert: third_handoff_aborted"

DRAFT_N=$(run_sql -c "select count(*) from public.outreach_drafts where ops_idempotency_key like '%:pl-inv-%';")
REC_N=$(run_sql -c "select count(*) from public.agh_handoff_records where playlist_target_id like 'pl-inv-%';")
BATCH_N=$(run_sql -c "select count(*) from public.agh_handoff_batches where track_id = '11111111-1111-1111-1111-111111111111' and id <> '33333333-3333-3333-3333-333333333333';")
assert_eq "rollback_zero_drafts" "${DRAFT_N}" "0"
assert_eq "rollback_zero_records" "${REC_N}" "0"
assert_eq "rollback_zero_new_batches" "${BATCH_N}" "0"

run_sql_pretty -c "drop trigger if exists trg_agh_test_fail_third on public.agh_handoff_records;"
run_sql_pretty -c "drop function if exists public._agh_test_fail_third_handoff();"

echo "==> Concurrent identical inventory requests → one logical result"
ITEMS_JSON='[{"playlist_id":"pl-inv-1","channel":"email","idempotency_key":"11111111-1111-1111-1111-111111111111:pl-inv-1:email:22222222-2222-2222-2222-222222222222","draft":{"body":"body","track_name":"Test Track","subject":"hi"},"packet":{"packet_kind":"email_outreach_draft"}}]'
TMPA=$(mktemp)
TMPB=$(mktemp)
(
  run_sql -c "select public.agh_mcp_persist_playlist_inventory(
    '11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222',
    '{\"discovered_by\":\"claude_playlist_discovery\"}'::jsonb,
    '${ITEMS_JSON}'::jsonb
  ) ->> 'ok';" >"$TMPA"
) &
(
  run_sql -c "select public.agh_mcp_persist_playlist_inventory(
    '11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222',
    '{\"discovered_by\":\"claude_playlist_discovery\"}'::jsonb,
    '${ITEMS_JSON}'::jsonb
  ) ->> 'ok';" >"$TMPB"
) &
wait
A=$(tr -d '[:space:]' <"$TMPA")
B=$(tr -d '[:space:]' <"$TMPB")
rm -f "$TMPA" "$TMPB"
SUCCESS_N=0
[[ "${A}" == "true" ]] && SUCCESS_N=$((SUCCESS_N + 1))
[[ "${B}" == "true" ]] && SUCCESS_N=$((SUCCESS_N + 1))
# Both may return ok=true if race resolves to idempotent; drafts/records must be singular.
assert_eq "concurrent_inventory_ok_calls" "${SUCCESS_N}" "2"
DRAFT_N=$(run_sql -c "select count(*) from public.outreach_drafts where status in ('pending','approved');")
REC_N=$(run_sql -c "select count(*) from public.agh_handoff_records where playlist_target_id='pl-inv-1' and queue_state not in ('REJECTED_BY_GROK','IMPORTED_TO_AGH');")
assert_eq "concurrent_one_active_draft" "${DRAFT_N}" "1"
assert_eq "concurrent_one_open_handoff" "${REC_N}" "1"

echo "==> Terminal draft retry allowed (rejected → new pending with same key)"
run_sql_pretty <<'SQL'
update public.outreach_drafts set status = 'rejected' where ops_idempotency_key like '%pl-inv-1%';
update public.agh_handoff_records set queue_state = 'REJECTED_BY_GROK' where playlist_target_id = 'pl-inv-1';
SQL
RETRY_OK=$(run_sql -c "select public.agh_mcp_persist_playlist_inventory(
  '11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222222',
  '{\"discovered_by\":\"claude_playlist_discovery\"}'::jsonb,
  '${ITEMS_JSON}'::jsonb
) ->> 'ok';")
assert_eq "terminal_retry_ok" "${RETRY_OK}" "true"
ACTIVE_DRAFTS=$(run_sql -c "select count(*) from public.outreach_drafts where status in ('pending','approved') and ops_idempotency_key like '%pl-inv-1%';")
assert_eq "terminal_retry_one_active" "${ACTIVE_DRAFTS}" "1"

echo "==> Pitch campaigns current-state adoption (table absent)"
apply_with_rollback "$ROOT/supabase/migrations/20260908000000_pitch_campaigns_current_state_adoption.sql"
PC_EXISTS=$(run_sql -c "select count(*) from information_schema.tables where table_schema='public' and table_name='pitch_campaigns';")
assert_eq "pitch_campaigns_created" "${PC_EXISTS}" "1"
PC_ROWS=$(run_sql -c "select count(*) from public.pitch_campaigns;")
assert_eq "pitch_campaigns_no_auto_seed" "${PC_ROWS}" "0"
DNA_COL=$(run_sql -c "select count(*) from information_schema.columns where table_schema='public' and table_name='pitch_campaigns' and column_name='song_dna_version_id';")
assert_eq "pitch_campaigns_song_dna_col" "${DNA_COL}" "1"
SNAP_COL=$(run_sql -c "select count(*) from information_schema.columns where table_schema='public' and table_name='pitch_campaigns' and column_name='configuration_snapshot';")
assert_eq "pitch_campaigns_snapshot_col" "${SNAP_COL}" "1"
APPROVED_COL=$(run_sql -c "select count(*) from information_schema.columns where table_schema='public' and table_name='pitch_campaigns' and column_name='approved_by';")
assert_eq "pitch_campaigns_approved_by_col" "${APPROVED_COL}" "1"
OPEN_IDX=$(run_sql -c "select count(*) from pg_indexes where schemaname='public' and indexname='pitch_campaigns_one_open_per_track';")
assert_eq "pitch_campaigns_one_open_idx" "${OPEN_IDX}" "1"
# No hard-coded production titles in the adoption migration itself
SEED_HITS=$(grep -ciE 'meditate|designed for me|designedforme' "$ROOT/supabase/migrations/20260908000000_pitch_campaigns_current_state_adoption.sql" || true)
assert_eq "adoption_migration_no_hardcoded_songs" "${SEED_HITS:-0}" "0"

echo "==> Pitch campaigns adoption over partial historical schema"
run_sql_pretty <<'SQL'
drop table if exists public.pitch_campaigns cascade;
create table public.pitch_campaigns (
  id uuid primary key default gen_random_uuid(),
  track_id uuid not null references public.tracks(id) on delete cascade,
  smart_link_id uuid,
  status text not null default 'active',
  daily_target integer not null default 20,
  notes text,
  pitch_copy text,
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Partial historical active row without DNA/snapshot — must be auto-paused on adopt
insert into public.tracks (id, name, status)
values ('99999999-9999-9999-9999-999999999999', 'Fixture Partial Track', 'active')
on conflict (id) do nothing;
insert into public.pitch_campaigns (track_id, status, daily_target, pitch_copy, started_at)
values (
  '99999999-9999-9999-9999-999999999999',
  'active',
  20,
  'legacy reconstructed copy must not keep this active',
  now()
);
SQL
apply_with_rollback "$ROOT/supabase/migrations/20260908000000_pitch_campaigns_current_state_adoption.sql"
PARTIAL_STATUS=$(run_sql -c "select status from public.pitch_campaigns where track_id='99999999-9999-9999-9999-999999999999';")
assert_eq "partial_active_paused_for_incomplete" "${PARTIAL_STATUS}" "paused"
PARTIAL_DNA=$(run_sql -c "select count(*) from information_schema.columns where table_schema='public' and table_name='pitch_campaigns' and column_name='song_dna_version_id';")
assert_eq "partial_gained_song_dna_col" "${PARTIAL_DNA}" "1"
PARTIAL_ROWS=$(run_sql -c "select count(*) from public.pitch_campaigns;")
assert_eq "partial_no_extra_seed_rows" "${PARTIAL_ROWS}" "1"

echo "==> Active campaign completeness refuses missing DNA/smart-link at DB layer"
run_sql_pretty <<'SQL'
insert into public.smart_links (id, slug, title, is_active)
values ('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'fixture-link', 'Fixture Link', true)
on conflict (id) do nothing;
insert into public.song_dna_versions (id, track_id, approval_state, short_pitch, approved_lanes)
values (
  'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
  '99999999-9999-9999-9999-999999999999',
  'approved',
  'Fixture approved DNA pitch',
  array['rap_general']
)
on conflict (id) do nothing;
update public.tracks
   set approved_song_dna_version_id = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff'
 where id = '99999999-9999-9999-9999-999999999999';
SQL

set +e
BAD_ACTIVE=$(run_sql_pretty -c "update public.pitch_campaigns
  set status='active', smart_link_id=null, song_dna_version_id=null, configuration_snapshot='{}'::jsonb
 where track_id='99999999-9999-9999-9999-999999999999';" 2>&1)
BAD_RC=$?
set -e
if [[ ${BAD_RC} -eq 0 ]]; then
  echo "FAIL: expected active without DNA/smart-link/snapshot to be rejected"
  echo "${BAD_ACTIVE}"
  psql_admin -c "DROP DATABASE IF EXISTS ${DB_NAME};" || true
  exit 1
fi
echo "OK assert: active_incomplete_rejected"

run_sql_pretty -c "update public.pitch_campaigns
  set status='active',
      smart_link_id='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      song_dna_version_id='bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
      configuration_snapshot=jsonb_build_object('snapshot_source','server_activation','song_dna_version_id','bbbbbbbb-cccc-dddd-eeee-ffffffffffff'),
      activated_at=now(),
      started_at=coalesce(started_at, now()),
      paused_at=null
 where track_id='99999999-9999-9999-9999-999999999999';" >/dev/null
GOOD_ACTIVE=$(run_sql -c "select status from public.pitch_campaigns where track_id='99999999-9999-9999-9999-999999999999';")
assert_eq "active_complete_allowed" "${GOOD_ACTIVE}" "active"

ACTIVE_FOR_CLAUDE=$(run_sql -c "select count(*) from public.pitch_campaigns where status='active';")
assert_eq "active_campaigns_visible" "${ACTIVE_FOR_CLAUDE}" "1"
PAUSED_EXCLUDED=$(run_sql -c "select count(*) from public.pitch_campaigns c
  join public.tracks t on t.id=c.track_id
 where c.status='active' and t.name='Fixture Partial Track' and c.song_dna_version_id is null;")
assert_eq "incomplete_not_active" "${PAUSED_EXCLUDED}" "0"

echo "==> Batch drafted_by attribution repair + safe backfill"
apply_with_rollback "$ROOT/supabase/migrations/20260910160000_batch_drafted_by_attribution.sql"
RECON_TBL=$(run_sql -c "select count(*) from information_schema.tables where table_schema='public' and table_name='agh_batch_attribution_reconciliation';")
assert_eq "attribution_reconciliation_table" "${RECON_TBL}" "1"
BACKFILL_FN=$(run_sql -c "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='agh_backfill_batch_drafted_by';")
assert_eq "backfill_batch_drafted_by_fn" "${BACKFILL_FN}" "1"

# Seed: null batch drafted_by with unambiguous Claude records → backfill
run_sql_pretty <<'SQL'
insert into public.playlist_targets (playlist_id, lane, verification_status, path_verified, contact_method, submission_method, curator_email)
values
  ('pl-attr-1', 'rap_general', 'auto_verified', true, 'email', 'email', 'a@test'),
  ('pl-attr-2a', 'rap_general', 'auto_verified', true, 'email', 'email', 'b@test'),
  ('pl-attr-2b', 'rap_general', 'auto_verified', true, 'email', 'email', 'c@test')
on conflict (playlist_id) do nothing;

insert into public.agh_handoff_batches (
  id, batch_kind, queue_state, track_id, song_dna_version_id,
  discovered_by, discovered_by_label, drafted_by, drafted_by_label, record_count
) values (
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', 'playlist', 'CLAUDE_BATCH_READY',
  '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
  'claude_playlist_discovery', 'claude_playlist_discovery', null, null, 1
);

insert into public.agh_handoff_records (
  id, batch_id, record_kind, queue_state, track_id, playlist_target_id,
  submission_channel, song_dna_version_id, packet,
  discovered_by, discovered_by_label, drafted_by, drafted_by_label
) values (
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
  'playlist_target', 'CLAUDE_BATCH_READY',
  '11111111-1111-1111-1111-111111111111', 'pl-attr-1', 'email',
  '22222222-2222-2222-2222-222222222222', '{}'::jsonb,
  'claude_playlist_discovery', 'claude_playlist_discovery',
  'claude_playlist_discovery', 'claude_playlist_discovery'
);

-- Mixed actors → must flag, not overwrite
insert into public.agh_handoff_batches (
  id, batch_kind, queue_state, track_id, song_dna_version_id,
  discovered_by, discovered_by_label, drafted_by, record_count
) values (
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2', 'playlist', 'CLAUDE_BATCH_READY',
  '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
  'claude_playlist_discovery', 'claude_playlist_discovery', null, 2
);

insert into public.agh_handoff_records (
  id, batch_id, record_kind, queue_state, track_id, playlist_target_id,
  submission_channel, song_dna_version_id, packet,
  discovered_by, discovered_by_label, drafted_by, drafted_by_label
) values
(
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2',
  'playlist_target', 'CLAUDE_BATCH_READY',
  '11111111-1111-1111-1111-111111111111', 'pl-attr-2a', 'email',
  '22222222-2222-2222-2222-222222222222', '{}'::jsonb,
  'claude_playlist_discovery', 'claude_playlist_discovery',
  'claude_playlist_discovery', 'claude_playlist_discovery'
),
(
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb3',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2',
  'playlist_target', 'CLAUDE_BATCH_READY',
  '11111111-1111-1111-1111-111111111111', 'pl-attr-2b', 'email',
  '22222222-2222-2222-2222-222222222222', '{}'::jsonb,
  'fendi', 'fendi', 'fendi', 'fendi'
);
SQL

BF=$(run_sql -c "select public.agh_backfill_batch_drafted_by()::text;")
echo "backfill_result=${BF}"
BF_OK=$(run_sql -c "select public.agh_backfill_batch_drafted_by() ->> 'ok';")
assert_eq "backfill_ok" "${BF_OK}" "true"
FILLED=$(run_sql -c "select drafted_by from public.agh_handoff_batches where id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1';")
assert_eq "unambiguous_batch_drafted_by" "${FILLED}" "claude_playlist_discovery"
MIXED_STILL_NULL=$(run_sql -c "select coalesce(drafted_by, 'NULL') from public.agh_handoff_batches where id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2';")
assert_eq "mixed_batch_left_null" "${MIXED_STILL_NULL}" "NULL"
FLAGGED=$(run_sql -c "select reason from public.agh_batch_attribution_reconciliation where batch_id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2';")
assert_eq "mixed_flagged_reason" "${FLAGGED}" "mixed_record_actors"
STATE_PRESERVED=$(run_sql -c "select queue_state from public.agh_handoff_batches where id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1';")
assert_eq "backfill_preserves_queue_state" "${STATE_PRESERVED}" "CLAUDE_BATCH_READY"

# Persist RPC must write batch drafted_by on create (reuse seeded pl-inv targets pattern)
PERSIST_ATTR_OK=$(run_sql -c "select public.agh_mcp_persist_playlist_inventory(
  '11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222222',
  '{\"discovered_by\":\"claude_playlist_discovery\",\"discovered_by_label\":\"claude_playlist_discovery\",\"drafted_by\":\"claude_playlist_discovery\",\"drafted_by_label\":\"claude_playlist_discovery\"}'::jsonb,
  '[{\"playlist_id\":\"pl-inv-2\",\"channel\":\"email\",\"idempotency_key\":\"11111111-1111-1111-1111-111111111111:pl-inv-2:email:22222222-2222-2222-2222-222222222222\",\"record_kind\":\"playlist_target\",\"queue_state\":\"CLAUDE_BATCH_READY\",\"packet\":{\"packet_kind\":\"email_outreach_draft\"},\"draft\":{\"track_name\":\"Test Track\",\"recipient\":\"b@test\",\"subject\":\"S\",\"body\":\"server pitch\",\"pitch_copy_source\":\"song_dna\",\"pitch_copy_hash\":\"h\",\"generated_by\":\"claude_playlist_discovery\",\"metadata\":{}}}]'::jsonb
) ->> 'ok';")
assert_eq "persist_attr_ok" "${PERSIST_ATTR_OK}" "true"
PERSIST_BATCH=$(run_sql -c "select drafted_by from public.agh_handoff_batches where id = (
  select batch_id from public.agh_handoff_records where playlist_target_id='pl-inv-2' and queue_state not in ('REJECTED_BY_GROK','IMPORTED_TO_AGH') limit 1
);")
assert_eq "persist_sets_batch_drafted_by" "${PERSIST_BATCH}" "claude_playlist_discovery"

echo "==> PASS: daily-ops migrations applied + authoritative RPC assertions verified"
