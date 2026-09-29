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
apply_with_rollback "$ROOT/supabase/migrations/20260915120000_playlist_inventory_drafted_by_promote.sql"
apply_with_rollback "$ROOT/supabase/migrations/20260916120000_email_handoff_packet_materialize.sql"
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
REC_DRAFTED=$(run_sql -c "select drafted_by from public.agh_handoff_records where playlist_target_id='pl-inv-1' and queue_state not in ('REJECTED_BY_GROK','IMPORTED_TO_AGH') limit 1;")
assert_eq "persist_record_drafted_by" "${REC_DRAFTED}" "claude_playlist_discovery"
BATCH_DRAFTED=$(run_sql -c "select drafted_by from public.agh_handoff_batches where track_id='11111111-1111-1111-1111-111111111111' and id <> '33333333-3333-3333-3333-333333333333' order by created_at desc limit 1;")
assert_eq "persist_batch_drafted_by" "${BATCH_DRAFTED}" "claude_playlist_discovery"
PKT_EMAIL=$(run_sql -c "select packet->>'curator_email' from public.agh_handoff_records where playlist_target_id='pl-inv-1' and queue_state not in ('REJECTED_BY_GROK','IMPORTED_TO_AGH') limit 1;")
assert_eq "persist_packet_curator_email" "${PKT_EMAIL}" "a@test"
PKT_DRAFT=$(run_sql -c "select (packet->>'outreach_draft_id') is not null and (packet->>'outreach_draft_id') = outreach_draft_id::text from public.agh_handoff_records where playlist_target_id='pl-inv-1' and queue_state not in ('REJECTED_BY_GROK','IMPORTED_TO_AGH') limit 1;")
assert_eq "persist_packet_outreach_draft_id" "${PKT_DRAFT}" "t"
PKT_COPY=$(run_sql -c "select (packet ? 'body') or (packet ? 'subject') from public.agh_handoff_records where playlist_target_id='pl-inv-1' and queue_state not in ('REJECTED_BY_GROK','IMPORTED_TO_AGH') limit 1;")
assert_eq "persist_packet_no_copy" "${PKT_COPY}" "f"

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

echo "==> Email handoff packet materialize (thin shells + terminal-unsent clone)"
TITLE_HITS=$(grep -ciE 'meditate|designed for me|designedforme' "$ROOT/supabase/migrations/20260916120000_email_handoff_packet_materialize.sql" || true)
assert_eq "materialize_migration_no_hardcoded_songs" "${TITLE_HITS:-0}" "0"
MAT_FN=$(run_sql -c "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='agh_materialize_email_handoff_drafts';")
assert_eq "materialize_fn_present" "${MAT_FN}" "1"

run_sql_pretty <<'SQL'
insert into public.playlist_targets (playlist_id, lane, verification_status, path_verified, contact_method, submission_method, curator_email)
values
  ('pl-mat-reject', 'rap_general', 'auto_verified', true, 'email', 'email', 'reject@test'),
  ('pl-mat-sent', 'rap_general', 'auto_verified', true, 'email', 'email', 'sent@test'),
  ('pl-mat-form', 'rap_general', 'auto_verified', true, 'web_form', 'web_form', null)
on conflict (playlist_id) do update set curator_email = excluded.curator_email;

insert into public.agh_handoff_batches (id, batch_kind, queue_state, track_id, song_dna_version_id, discovered_by, drafted_by)
values (
  '55555555-5555-5555-5555-555555555555',
  'playlist', 'AWAITING_GROK_REVIEW',
  '11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222222',
  'claude_playlist_discovery', 'claude_playlist_discovery'
);

insert into public.outreach_drafts (
  id, playlist_id, track_id, track_name, song_dna_version_id, channel, status,
  generated_by, subject, body, recipient, ops_idempotency_key
) values
  ('66666666-6666-6666-6666-666666666601', 'pl-mat-reject',
   '11111111-1111-1111-1111-111111111111', 'Test Track',
   '22222222-2222-2222-2222-222222222222', 'email', 'rejected',
   'claude_playlist_discovery', 'subj-r', 'body-r', 'reject@test',
   '11111111-1111-1111-1111-111111111111:pl-mat-reject:email:22222222-2222-2222-2222-222222222222'),
  ('66666666-6666-6666-6666-666666666602', 'pl-mat-sent',
   '11111111-1111-1111-1111-111111111111', 'Test Track',
   '22222222-2222-2222-2222-222222222222', 'email', 'sent',
   'claude_playlist_discovery', 'subj-s', 'body-s', 'sent@test',
   '11111111-1111-1111-1111-111111111111:pl-mat-sent:email:22222222-2222-2222-2222-222222222222');

insert into public.agh_handoff_records (
  id, batch_id, record_kind, queue_state, track_id, playlist_target_id,
  outreach_draft_id, submission_channel, song_dna_version_id, packet, drafted_by
) values
  ('77777777-7777-7777-7777-777777777701', '55555555-5555-5555-5555-555555555555',
   'playlist_target', 'AWAITING_GROK_REVIEW',
   '11111111-1111-1111-1111-111111111111', 'pl-mat-reject',
   '66666666-6666-6666-6666-666666666601', 'email',
   '22222222-2222-2222-2222-222222222222',
   '{"packet_kind":"email_outreach_draft","channel":"email"}'::jsonb,
   'claude_playlist_discovery'),
  ('77777777-7777-7777-7777-777777777702', '55555555-5555-5555-5555-555555555555',
   'playlist_target', 'AWAITING_GROK_REVIEW',
   '11111111-1111-1111-1111-111111111111', 'pl-mat-sent',
   '66666666-6666-6666-6666-666666666602', 'email',
   '22222222-2222-2222-2222-222222222222',
   '{"packet_kind":"email_outreach_draft","channel":"email"}'::jsonb,
   'claude_playlist_discovery'),
  ('77777777-7777-7777-7777-777777777703', '55555555-5555-5555-5555-555555555555',
   'playlist_target', 'AWAITING_GROK_REVIEW',
   '11111111-1111-1111-1111-111111111111', 'pl-mat-form',
   null, 'web_form',
   '22222222-2222-2222-2222-222222222222',
   '{"packet_kind":"manual_web_form_packet","form_url":"https://form.test"}'::jsonb,
   'claude_playlist_discovery');
SQL

DRY=$(run_sql -c "select public.agh_materialize_email_handoff_drafts(true) ->> 'cloned_pending';")
assert_eq "materialize_dry_cloned" "${DRY}" "1"
DRY_SENT=$(run_sql -c "select public.agh_materialize_email_handoff_drafts(true) ->> 'already_sent';")
assert_eq "materialize_dry_already_sent" "${DRY_SENT}" "1"
# Scope to the fixture batch: earlier sections leave CLAUDE_BATCH_READY email records
# behind, which the (unscoped) materializer also scans. The batch holds 2 email + 1 web-form.
DRY_SCAN=$(run_sql -c "select public.agh_materialize_email_handoff_drafts(true, '55555555-5555-5555-5555-555555555555'::uuid) ->> 'scanned';")
assert_eq "materialize_dry_scanned_email_only" "${DRY_SCAN}" "2"
STILL_THIN=$(run_sql -c "select count(*) from public.agh_handoff_records where id='77777777-7777-7777-7777-777777777701' and coalesce(packet->>'curator_email','')='';")
assert_eq "materialize_dry_run_no_write" "${STILL_THIN}" "1"

WET=$(run_sql -c "select public.agh_materialize_email_handoff_drafts(false) ->> 'ok';")
assert_eq "materialize_wet_ok" "${WET}" "true"
NEW_PENDING=$(run_sql -c "select count(*) from public.outreach_drafts where playlist_id='pl-mat-reject' and status='pending';")
assert_eq "materialize_cloned_pending" "${NEW_PENDING}" "1"
RELINKED=$(run_sql -c "select (outreach_draft_id <> '66666666-6666-6666-6666-666666666601') and (packet->>'curator_email')='reject@test' and (packet->>'email_sendable')='true' from public.agh_handoff_records where id='77777777-7777-7777-7777-777777777701';")
assert_eq "materialize_relink_packet" "${RELINKED}" "t"
SENT_PKT=$(run_sql -c "select (packet->>'curator_email')='sent@test' and (packet->>'email_sendable')='false' and outreach_draft_id='66666666-6666-6666-6666-666666666602' from public.agh_handoff_records where id='77777777-7777-7777-7777-777777777702';")
assert_eq "materialize_sent_not_cloned" "${SENT_PKT}" "t"
FORM_UNTOUCHED=$(run_sql -c "select packet->>'packet_kind' from public.agh_handoff_records where id='77777777-7777-7777-7777-777777777703';")
assert_eq "materialize_web_form_untouched" "${FORM_UNTOUCHED}" "manual_web_form_packet"
IDEMP=$(run_sql -c "select public.agh_materialize_email_handoff_drafts(false) ->> 'cloned_pending';")
assert_eq "materialize_second_pass_no_reclone" "${IDEMP}" "0"

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

echo "==> Route hold + candidate log (2026-09-27 false route verification)"
run_sql_pretty <<'SQL' >/dev/null
alter table public.playlist_targets
  add column if not exists submission_url text,
  add column if not exists curator_instagram text,
  add column if not exists contact_method text,
  add column if not exists submission_method text,
  add column if not exists curator_email text,
  add column if not exists path_verification_notes text,
  add column if not exists research_context jsonb,
  add column if not exists is_active boolean default true,
  add column if not exists updated_at timestamptz;
SQL
apply_with_rollback "$ROOT/supabase/migrations/20260927120000_route_hold_and_candidate_log.sql"

# Rule parity with submission-route.ts
RC_NULL=$(run_sql -c "select public.agh_route_failure_code('web_form','auto_verified',true,null,null,null,'Spotify playlist by curator X. no submission route confirmed at time of check.',null,null);")
assert_eq "route_rule_null_form" "${RC_NULL}" "missing_form_url"
RC_SPOT=$(run_sql -c "select public.agh_route_failure_code('web_form','auto_verified',true,null,'https://open.spotify.com/playlist/370YtLfVc3bwtUp3uhyyAO',null,'Spotify playlist by curator',null,null);")
assert_eq "route_rule_spotify_form" "${RC_SPOT}" "spotify_url_as_form"
RC_NEG=$(run_sql -c "select public.agh_route_failure_code('web_form','auto_verified',true,null,'https://curator.example/submit',null,'Curator page; no submission route confirmed at time of check.',null,null);")
assert_eq "route_rule_negated_evidence" "${RC_NEG}" "evidence_negates_route"
RC_OK=$(run_sql -c "select coalesce(public.agh_route_failure_code('web_form','auto_verified',true,null,'https://dailyplaylists.com/submit-song/add-song',null,'DailyPlaylists free house list: Club Music 2025',null,null),'ok');")
assert_eq "route_rule_valid_form" "${RC_OK}" "ok"
RC_SP=$(run_sql -c "select coalesce(public.agh_route_failure_code('web_form','auto_verified',true,null,'https://soundplate.com/submit-music/',null,'Soundplate curator submission page for the playlist',null,null),'ok');")
assert_eq "route_rule_soundplate_form" "${RC_SP}" "ok"
RC_EMAIL=$(run_sql -c "select coalesce(public.agh_route_failure_code('email','auto_verified',false,'curator@label.test',null,'https://open.spotify.com/playlist/x',null,null,null),'ok');")
assert_eq "route_rule_legacy_email_ok" "${RC_EMAIL}" "ok"
RC_UNV=$(run_sql -c "select public.agh_route_failure_code('web_form','auto_verified',false,null,'https://curator.example/submit',null,'form linked from curator site',null,null);")
assert_eq "route_rule_form_needs_path_flag" "${RC_UNV}" "route_not_verified"
RC_UNLINKED=$(run_sql -c "select public.agh_route_failure_code('web_form','auto_verified',true,null,'https://dailyplaylists.com/',null,'Spotify playlist by curator Spot, surfaced in a search for rap playlists accepting free 2026 submissions.',null,null);")
assert_eq "route_rule_unlinked_evidence" "${RC_UNLINKED}" "evidence_not_linked_to_form"
RC_LINKED=$(run_sql -c "select coalesce(public.agh_route_failure_code('web_form','auto_verified',true,null,'https://dailyplaylists.com/',null,'owned by curator Daily Playlists, whose own submission portal is dailyplaylists.com.',null,null),'ok');")
assert_eq "route_rule_linked_evidence" "${RC_LINKED}" "ok"
RC_SRC=$(run_sql -c "select coalesce(public.agh_route_failure_code('web_form','auto_verified',true,null,'https://play.soundplate.com/theunder',null,'listed with a submit link',null,null,'https://soundplate.com/some-post/'),'ok');")
assert_eq "route_rule_source_url_links" "${RC_SRC}" "ok"
RC_GF=$(run_sql -c "select coalesce(public.agh_route_failure_code('web_form','auto_verified',true,null,'https://forms.gle/AbC123',null,'curator bio links a submission form',null,null),'ok');")
assert_eq "route_rule_form_builder" "${RC_GF}" "ok"
RC_INACTIVE=$(run_sql -c "select public.agh_route_failure_code('email','auto_verified',false,'jointheplaylist@teamspecific.com',null,null,null,null,null,null,false);")
assert_eq "route_rule_inactive" "${RC_INACTIVE}" "target_inactive"

run_sql_pretty <<'SQL' >/dev/null
insert into public.playlist_targets (playlist_id, lane, verification_status, path_verified, contact_method, submission_method, form_url, submission_url, form_source_evidence, path_verification_notes)
values
  ('rh-null-1', 'deep_house_groove', 'auto_verified', true, 'web_form', 'web_form', null, null,
   'Spotify playlist ''Deep Groove House'' by curator Chosic. no submission route confirmed at time of check.',
   'web form URL + source evidence verified (no automated submit)'),
  ('rh-spot-1', 'house_general', 'auto_verified', true, 'web_form', 'web_form',
   'https://open.spotify.com/playlist/370YtLfVc3bwtUp3uhyyAO', 'https://open.spotify.com/playlist/370YtLfVc3bwtUp3uhyyAO',
   'Spotify playlist by curator House Music Radar', 'web form URL + source evidence verified (no automated submit)'),
  ('rh-ok-1', 'house_club', 'auto_verified', true, 'web_form', 'web_form',
   'https://dailyplaylists.com/submit-song/add-song', 'https://dailyplaylists.com/submit-song/add-song',
   'DailyPlaylists free house list: Club Music 2025', 'web form URL + source evidence verified (no automated submit)');

insert into public.agh_handoff_batches (id, batch_kind, queue_state, track_id, song_dna_version_id, discovered_by, drafted_by, record_count)
values ('abababab-0000-0000-0000-000000000001', 'playlist', 'AWAITING_GROK_REVIEW',
        '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
        'claude_playlist_discovery', 'claude_playlist_discovery', 3);

insert into public.agh_handoff_records (id, batch_id, record_kind, queue_state, track_id, playlist_target_id, submission_channel, song_dna_version_id, packet, drafted_by)
values
  ('abababab-0000-0000-0000-0000000000a1', 'abababab-0000-0000-0000-000000000001', 'playlist_target', 'AWAITING_GROK_REVIEW',
   '11111111-1111-1111-1111-111111111111', 'rh-null-1', 'web_form', '22222222-2222-2222-2222-222222222222',
   '{"packet_kind":"manual_web_form_packet","form_url":null}'::jsonb, 'claude_playlist_discovery'),
  ('abababab-0000-0000-0000-0000000000a2', 'abababab-0000-0000-0000-000000000001', 'playlist_target', 'AWAITING_GROK_REVIEW',
   '11111111-1111-1111-1111-111111111111', 'rh-spot-1', 'web_form', '22222222-2222-2222-2222-222222222222',
   '{"packet_kind":"manual_web_form_packet","form_url":"https://open.spotify.com/playlist/370YtLfVc3bwtUp3uhyyAO"}'::jsonb, 'claude_playlist_discovery'),
  ('abababab-0000-0000-0000-0000000000a3', 'abababab-0000-0000-0000-000000000001', 'playlist_target', 'AWAITING_GROK_REVIEW',
   '11111111-1111-1111-1111-111111111111', 'rh-ok-1', 'web_form', '22222222-2222-2222-2222-222222222222',
   '{"packet_kind":"manual_web_form_packet","form_url":"https://dailyplaylists.com/submit-song/add-song"}'::jsonb, 'claude_playlist_discovery');
SQL

echo "route audit preview (whole fixture DB): $(run_sql -c "select public.agh_route_hold_audit(false)->'by_code';")"
PREVIEW=$(run_sql -c "select count(*) from jsonb_array_elements(public.agh_route_hold_audit(false)->'records') i where i->>'batch_id'='abababab-0000-0000-0000-000000000001';")
assert_eq "route_audit_preview_count" "${PREVIEW}" "2"
STILL=$(run_sql -c "select count(*) from public.agh_handoff_records where batch_id='abababab-0000-0000-0000-000000000001';")
assert_eq "route_audit_preview_no_write" "${STILL}" "3"

APPLIED=$(run_sql -c "select count(*) from jsonb_array_elements(public.agh_route_hold_audit(true)->'hold_result'->'held') h where h->>'from_batch_id'='abababab-0000-0000-0000-000000000001';")
assert_eq "route_audit_held" "${APPLIED}" "2"
KEPT=$(run_sql -c "select string_agg(playlist_target_id, ',') from public.agh_handoff_records where batch_id='abababab-0000-0000-0000-000000000001';")
assert_eq "route_audit_valid_record_stays" "${KEPT}" "rh-ok-1"
SRC_COUNT=$(run_sql -c "select record_count from public.agh_handoff_batches where id='abababab-0000-0000-0000-000000000001';")
assert_eq "route_audit_source_count" "${SRC_COUNT}" "1"
SRC_STATE=$(run_sql -c "select queue_state from public.agh_handoff_batches where id='abababab-0000-0000-0000-000000000001';")
assert_eq "route_audit_source_state_untouched" "${SRC_STATE}" "AWAITING_GROK_REVIEW"
REPAIR=$(run_sql -c "select queue_state || ':' || record_count || ':' || (payload->>'route_hold_repair') from public.agh_handoff_batches where payload->>'route_hold_source_batch'='abababab-0000-0000-0000-000000000001';")
assert_eq "route_audit_repair_batch" "${REPAIR}" "CLAUDE_BATCH_READY:2:true"
HOLD_CODES=$(run_sql -c "select string_agg(packet->'route_hold'->>'code', ',' order by playlist_target_id) from public.agh_handoff_records where packet ? 'route_hold' and id::text like 'abababab%';")
assert_eq "route_audit_hold_codes" "${HOLD_CODES}" "missing_form_url,spotify_url_as_form"
PRIOR=$(run_sql -c "select count(*) from public.agh_handoff_records where packet->'route_hold'->>'prior_queue_state'='AWAITING_GROK_REVIEW' and packet->'route_hold'->>'prior_batch_id'='abababab-0000-0000-0000-000000000001';")
assert_eq "route_audit_history_preserved" "${PRIOR}" "2"
TGT=$(run_sql -c "select count(*) from public.playlist_targets where playlist_id in ('rh-null-1','rh-spot-1') and path_verified=false and path_verification_notes like 'ROUTE_HOLD:%prior: web form URL%';")
assert_eq "route_audit_targets_marked" "${TGT}" "2"
OK_TGT=$(run_sql -c "select path_verified from public.playlist_targets where playlist_id='rh-ok-1';")
assert_eq "route_audit_valid_target_untouched" "${OK_TGT}" "t"
AGAIN=$(run_sql -c "select count(*) from jsonb_array_elements(public.agh_route_hold_audit(true)->'hold_result'->'held') h where (h->>'refreshed')::boolean and h->>'record_id' like 'abababab%';")
assert_eq "route_audit_idempotent_refresh_only" "${AGAIN}" "2"
BATCHES=$(run_sql -c "select count(*) from public.agh_handoff_batches where payload->>'route_hold_source_batch'='abababab-0000-0000-0000-000000000001';")
assert_eq "route_audit_single_repair_batch" "${BATCHES}" "1"

run_sql_pretty <<'SQL' >/dev/null
select public.agh_log_candidate_evaluation(date '2026-09-27', '11111111-1111-1111-1111-111111111111', 'spotify:1ApnlS1I4dNX4ZKAQIyu62', '1ApnlS1I4dNX4ZKAQIyu62', 'verified_eligible_new', null, true);
select public.agh_log_candidate_evaluation(date '2026-09-27', '11111111-1111-1111-1111-111111111111', 'spotify:1ApnlS1I4dNX4ZKAQIyu62', '1ApnlS1I4dNX4ZKAQIyu62', 'duplicate', 'existing_pair_already_drafted', false);
SQL
EVAL=$(run_sql -c "select outcome || ':' || attempts || ':' || created_target from public.agh_playlist_candidate_evaluations where identity_key='spotify:1ApnlS1I4dNX4ZKAQIyu62';")
assert_eq "candidate_log_retry_keeps_best" "${EVAL}" "verified_eligible_new:2:true"

run_sql_pretty <<'SQL' >/dev/null
insert into public.playlist_targets (playlist_id, lane, verification_status) values
  ('spotify:5wvhQwlEYjBYyzVHDQV5GL', 'deep_house_groove', 'manually_verified'),
  ('spotify:4cYfYj9cEXilMAsRJxn6Wk', 'deep_house_groove', 'manually_verified'),
  ('4cYfYj9cEXilMAsRJxn6Wk', 'deep_house_groove', 'auto_verified'),
  ('spotify:sfa:abc123', 'rap_general', 'unverified');
SQL
ALIAS=$(run_sql -c "select (r->>'prefixed_rows') || ':' || (r->>'prefixed_manually_verified') || ':' || (r->>'collision_count') from (select public.agh_spotify_key_alias_report() r) x;")
assert_eq "spotify_alias_report" "${ALIAS}" "2:2:1"

echo "==> Record-level review + fit requeue (2026-09-28)"
apply_with_rollback "$ROOT/supabase/migrations/20260928120000_record_review_and_fit_requeue.sql"
run_sql_pretty <<'SQL' >/dev/null
alter table public.playlist_targets
  add column if not exists bounce_count int default 0,
  add column if not exists last_bounced_at timestamptz,
  add column if not exists ig_curator_account text,
  add column if not exists ig_source_evidence text;
insert into public.tracks (id, name, approved_song_dna_version_id)
values ('cccccccc-0000-0000-0000-00000000000a', 'Fixture Meditate', 'dddddddd-0000-0000-0000-00000000000a');
insert into public.song_dna_versions (id, track_id, approval_state, approved_lanes, excluded_lanes, primary_genre, short_pitch)
values ('dddddddd-0000-0000-0000-00000000000a', 'cccccccc-0000-0000-0000-00000000000a', 'approved',
        '{rap_general,rap_trap_hype,rap_conscious}', '{house_club}', 'hip_hop_rap', 'Hip-hop/rap with hard-hitting 808s');
insert into public.playlist_targets (playlist_id, lane, verification_status, path_verified, contact_method, submission_method, form_url, submission_url, form_source_evidence, curator_email, bounce_count, is_active)
values
  ('fit-trap', 'rap_trap_hype', 'auto_verified', true, 'web_form', 'web_form', 'https://play.soundplate.com/raphhrats', 'https://play.soundplate.com/raphhrats', 'Soundplate per-playlist submission page fetched 2026-09-28', null, 0, true),
  ('fit-house', 'house_club', 'auto_verified', true, 'web_form', 'web_form', 'https://play.soundplate.com/houseclub', 'https://play.soundplate.com/houseclub', 'Soundplate per-playlist submission page', null, 0, true),
  ('fit-conscious', 'rap_conscious', 'auto_verified', true, 'web_form', 'web_form', 'https://play.soundplate.com/realrap2', 'https://play.soundplate.com/realrap2', 'Soundplate per-playlist submission page', null, 0, true),
  ('fit-email', 'rap_general', 'auto_verified', false, 'email', 'email', null, null, null, 'jointheplaylist@teamspecific.test', 0, true),
  ('fit-email-old', 'rap_general', 'auto_verified', false, 'email', 'email', null, null, null, 'JoinThePlaylist@teamspecific.test', 1, true),
  ('fit-general', 'rap_general', 'auto_verified', true, 'web_form', 'web_form', 'https://play.soundplate.com/rblfreq', 'https://play.soundplate.com/rblfreq', 'Soundplate per-playlist submission page', null, 0, true);
insert into public.agh_handoff_batches (id, batch_kind, queue_state, track_id, song_dna_version_id, discovered_by, drafted_by, record_count)
values ('cccccccc-0000-0000-0000-0000000000b1', 'playlist', 'AWAITING_GROK_REVIEW', 'cccccccc-0000-0000-0000-00000000000a',
        'dddddddd-0000-0000-0000-00000000000a', 'claude_playlist_discovery', 'claude_playlist_discovery', 5);
insert into public.agh_handoff_records (id, batch_id, record_kind, queue_state, track_id, playlist_target_id, submission_channel, song_dna_version_id, packet, drafted_by)
values
  ('cccccccc-0000-0000-0000-0000000000c1', 'cccccccc-0000-0000-0000-0000000000b1', 'playlist_target', 'AWAITING_GROK_REVIEW', 'cccccccc-0000-0000-0000-00000000000a', 'fit-trap', 'web_form', 'dddddddd-0000-0000-0000-00000000000a', '{}'::jsonb, 'claude_playlist_discovery'),
  ('cccccccc-0000-0000-0000-0000000000c2', 'cccccccc-0000-0000-0000-0000000000b1', 'playlist_target', 'AWAITING_GROK_REVIEW', 'cccccccc-0000-0000-0000-00000000000a', 'fit-house', 'web_form', 'dddddddd-0000-0000-0000-00000000000a', '{}'::jsonb, 'claude_playlist_discovery'),
  ('cccccccc-0000-0000-0000-0000000000c3', 'cccccccc-0000-0000-0000-0000000000b1', 'playlist_target', 'AWAITING_GROK_REVIEW', 'cccccccc-0000-0000-0000-00000000000a', 'fit-conscious', 'web_form', 'dddddddd-0000-0000-0000-00000000000a', '{}'::jsonb, 'claude_playlist_discovery'),
  ('cccccccc-0000-0000-0000-0000000000c4', 'cccccccc-0000-0000-0000-0000000000b1', 'playlist_target', 'AWAITING_GROK_REVIEW', 'cccccccc-0000-0000-0000-00000000000a', 'fit-email', 'email', 'dddddddd-0000-0000-0000-00000000000a', '{}'::jsonb, 'claude_playlist_discovery'),
  ('cccccccc-0000-0000-0000-0000000000c5', 'cccccccc-0000-0000-0000-0000000000b1', 'playlist_target', 'AWAITING_GROK_REVIEW', 'cccccccc-0000-0000-0000-00000000000a', 'fit-general', 'web_form', 'dddddddd-0000-0000-0000-00000000000a', '{}'::jsonb, 'claude_playlist_discovery');
SQL

REV=$(run_sql -c "select (r->>'applied_count') || ':' || (r->>'batch_queue_state') from (select public.agh_review_handoff_records('cccccccc-0000-0000-0000-0000000000b1', '[
  {\"record_id\":\"cccccccc-0000-0000-0000-0000000000c1\",\"decision\":\"reject\",\"reason_codes\":[\"DNA_LANE_MISMATCH\"],\"reason\":\"Meditate hip_hop_rap only\"},
  {\"record_id\":\"cccccccc-0000-0000-0000-0000000000c2\",\"decision\":\"reject\",\"reason_codes\":[\"DNA_LANE_MISMATCH\"],\"reason\":\"Meditate hip_hop_rap only\"},
  {\"record_id\":\"cccccccc-0000-0000-0000-0000000000c3\",\"decision\":\"reject\",\"reason_codes\":[\"DNA_LANE_MISMATCH\",\"LOW_REACH\"],\"reason\":\"Meditate hip_hop_rap only\"},
  {\"record_id\":\"cccccccc-0000-0000-0000-0000000000c4\",\"decision\":\"reject\",\"reason_codes\":[\"DNA_LANE_MISMATCH\"]},
  {\"record_id\":\"cccccccc-0000-0000-0000-0000000000c5\",\"decision\":\"defer\",\"reason_codes\":[\"HOST_DOWN\"],\"retry_after\":\"2026-09-29\"}
]'::jsonb, 'grok_playlist_control', 'grok_playlist_control') r) x;")
assert_eq "record_review_applied_batch_still_pending" "${REV}" "5:AWAITING_GROK_REVIEW"
MIXED=$(run_sql -c "select count(*) from jsonb_array_elements(public.agh_handoff_state_audit()->'mixed_batches') b where b->>'batch_id'='cccccccc-0000-0000-0000-0000000000b1';")
assert_eq "audit_reports_mixed_batch" "${MIXED}" "1"
REJ=$(run_sql -c "select (a->'rejections'->>'distinct_rejected_records') || ':' || (a->'rejections'->>'reason_occurrences') || ':' || (a->'rejections'->>'fit_based_rejections') from (select public.agh_handoff_state_audit(array['cccccccc-0000-0000-0000-0000000000b1']::uuid[]) a) x;")
assert_eq "audit_distinct_vs_occurrences" "${REJ}" "4:5:4"
DEFER=$(run_sql -c "select packet->'review_defer'->>'retry_after' || ':' || queue_state from public.agh_handoff_records where id='cccccccc-0000-0000-0000-0000000000c5';")
assert_eq "defer_keeps_record_in_review" "${DEFER}" "2026-09-29:AWAITING_GROK_REVIEW"

run_sql -c "select public.advance_agh_handoff_batch('cccccccc-0000-0000-0000-0000000000b1', 'AWAITING_GROK_REVIEW', 'GROK_REVIEWED', '{\"reviewed_by\":\"grok_playlist_control\"}'::jsonb);" >/dev/null
AFTER=$(run_sql -c "select string_agg(queue_state, ',' order by id) from public.agh_handoff_records where batch_id='cccccccc-0000-0000-0000-0000000000b1';")
assert_eq "batch_advance_preserves_record_rejections" "${AFTER}" "REJECTED_BY_GROK,REJECTED_BY_GROK,REJECTED_BY_GROK,REJECTED_BY_GROK,GROK_REVIEWED"

PREV=$(run_sql -c "select (r->>'fit_rejections_found') || ':' || (r->>'eligible_for_requeue') || ':' || (r->>'requeued') from (select public.agh_fit_rejection_requeue(false) r) x;")
assert_eq "fit_requeue_preview" "${PREV}" "4:2:0"
SKIPS=$(run_sql -c "select string_agg(i->>'playlist_target_id' || '=' || coalesce(i->>'skip_reason','requeue'), ',' order by i->>'playlist_target_id') from jsonb_array_elements(public.agh_fit_rejection_requeue(false)->'records') i;")
assert_eq "fit_requeue_skip_reasons" "${SKIPS}" "fit-conscious=requeue,fit-email=curator_email_suppressed,fit-house=lane_excluded_by_dna,fit-trap=requeue"
APPLY=$(run_sql -c "select public.agh_fit_rejection_requeue(true)->>'requeued';")
assert_eq "fit_requeue_applied" "${APPLY}" "2"
RQ=$(run_sql -c "select b.queue_state || ':' || b.record_count || ':' || (b.payload->>'fit_requeue') from public.agh_handoff_batches b where b.payload->>'fit_requeue_source_batch'='cccccccc-0000-0000-0000-0000000000b1';")
assert_eq "fit_requeue_batch" "${RQ}" "AWAITING_GROK_REVIEW:2:true"
HIST=$(run_sql -c "select count(*) from public.agh_handoff_records where id in ('cccccccc-0000-0000-0000-0000000000c1','cccccccc-0000-0000-0000-0000000000c3') and queue_state='AWAITING_GROK_REVIEW' and rejection_reason is null and jsonb_array_length(packet->'review_history') = 2 and packet->'fit_requeue'->>'from_batch'='cccccccc-0000-0000-0000-0000000000b1';")
assert_eq "fit_requeue_history_preserved" "${HIST}" "2"
SRC=$(run_sql -c "select record_count from public.agh_handoff_batches where id='cccccccc-0000-0000-0000-0000000000b1';")
assert_eq "fit_requeue_source_recount" "${SRC}" "3"
AGAIN2=$(run_sql -c "select (r->>'fit_rejections_found') || ':' || (r->>'eligible_for_requeue') from (select public.agh_fit_rejection_requeue(false) r) x;")
assert_eq "fit_requeue_idempotent" "${AGAIN2}" "2:0"

RQID=$(run_sql -c "select id from public.agh_handoff_batches where payload->>'fit_requeue_source_batch'='cccccccc-0000-0000-0000-0000000000b1';")
ALLREJ=$(run_sql -c "select public.agh_review_handoff_records('${RQID}', '[
  {\"record_id\":\"cccccccc-0000-0000-0000-0000000000c1\",\"decision\":\"reject\",\"reason_codes\":[\"LOW_REACH\"]},
  {\"record_id\":\"cccccccc-0000-0000-0000-0000000000c3\",\"decision\":\"reject\",\"reason_codes\":[\"LANGUAGE_MISMATCH\"]}
]'::jsonb, 'grok_playlist_control', 'grok_playlist_control')->>'batch_queue_state';")
assert_eq "all_records_rejected_batch_follows" "${ALLREJ}" "REJECTED_BY_GROK"
DENY=$(run_sql -c "select has_function_privilege('authenticated', 'public.agh_review_handoff_records(uuid, jsonb, text, text)', 'execute');")
assert_eq "record_review_not_for_authenticated" "${DENY}" "f"

run_sql -c "select public.agh_log_candidate_evaluation(date '2026-09-28', 'cccccccc-0000-0000-0000-00000000000a', 'spotify:deferme', 'deferme', 'deferred', 'pair_cooldown', false);" >/dev/null
DEF=$(run_sql -c "select outcome from public.agh_playlist_candidate_evaluations where identity_key='spotify:deferme';")
assert_eq "candidate_outcome_deferred_allowed" "${DEF}" "deferred"

echo "==> Inventory/requeue follow-up (2026-09-29)"
run_sql_pretty <<'SQL' >/dev/null
create table public.artist_config (key text primary key, value jsonb not null);
create table public.pitch_log (
  playlist_id text, track_id uuid, track_name text, curator_email text, status text,
  sent_at timestamptz, pitched_at timestamptz, cooldown_until timestamptz
);
SQL
apply_with_rollback "$ROOT/supabase/migrations/20260929150000_playlist_inventory_requeue_safety.sql"
# Reapplying the installation must be harmless; it never runs the repair itself.
apply_with_rollback "$ROOT/supabase/migrations/20260929150000_playlist_inventory_requeue_safety.sql"
run_sql_pretty <<'SQL' >/dev/null
update public.agh_handoff_records
set rejection_reason = 'DNA_LANE_MISMATCH: Meditate hip_hop_rap only',
    packet = packet || '{"rejection":{"reason_codes":["DNA_LANE_MISMATCH"]}}'::jsonb
where id = 'cccccccc-0000-0000-0000-0000000000c1';
update public.agh_handoff_records
set rejection_reason = 'DNA_LANE_MISMATCH, LOW_REACH: Meditate hip_hop_rap only',
    packet = packet || '{"rejection":{"reason_codes":["DNA_LANE_MISMATCH","LOW_REACH"]}}'::jsonb
where id = 'cccccccc-0000-0000-0000-0000000000c3';
-- A sibling form submitted for the same song, even with different scheme/case/query.
update public.playlist_targets set form_url='http://www.play.soundplate.com/RAPHHRATS/?src=test' where playlist_id='fit-general';
update public.agh_handoff_records set submitted_at=now() - interval '2 days'
where id='cccccccc-0000-0000-0000-0000000000c5';
SQL
SAFE=$(run_sql -c "select string_agg(i->>'playlist_target_id' || '=' || coalesce(i->>'skip_reason','requeue'), ',' order by i->>'playlist_target_id') from jsonb_array_elements(public.agh_fit_rejection_requeue(false)->'records') i where i->>'playlist_target_id' in ('fit-trap','fit-conscious');")
assert_eq "safe_requeue_mixed_reason_and_curator_cooldown" "${SAFE}" "fit-conscious=other_or_ambiguous_rejection_reasons,fit-trap=curator_cooldown_active"
assert_eq "safe_requeue_apply_skips_blocked" "$(run_sql -c "select public.agh_fit_rejection_requeue(true)->>'requeued';")" "0"
# Different songs do not acquire a new cross-song cooldown.
assert_eq "cooldown_song_specific" "$(run_sql -c "select public.agh_requeue_contact_cooldown('fit-trap','aaaaaaaa-0000-0000-0000-000000000001');")" "f"
run_sql -c "insert into public.artist_config values ('cooldown_days','1');" >/dev/null
assert_eq "cooldown_honors_configured_duration" "$(run_sql -c "select public.agh_requeue_contact_cooldown('fit-trap','cccccccc-0000-0000-0000-00000000000a');")" "f"
# Email history, case-insensitive curator identity, explicit future expiry wins.
run_sql -c "insert into public.pitch_log values ('fit-email-old','cccccccc-0000-0000-0000-00000000000a','Fixture Meditate','JoinThePlaylist@teamspecific.test','sent',now()-interval '5 days',now()-interval '5 days',now()+interval '2 days');" >/dev/null
assert_eq "cooldown_email_explicit_expiry" "$(run_sql -c "select public.agh_requeue_contact_cooldown('fit-email','cccccccc-0000-0000-0000-00000000000a');")" "t"
# IG sibling identity also carries the existing per-song cooldown.
run_sql -c "update public.playlist_targets set form_url=null, ig_curator_account=case when playlist_id='fit-trap' then '@Curator' else 'curator' end where playlist_id in ('fit-trap','fit-general'); update public.agh_handoff_records set submitted_at=now() where id='cccccccc-0000-0000-0000-0000000000c5';" >/dev/null
assert_eq "cooldown_ig_sibling" "$(run_sql -c "select public.agh_requeue_contact_cooldown('fit-trap','cccccccc-0000-0000-0000-00000000000a');")" "t"
# End the cooldown: only the pure fit rejection can move; mixed rejection stays put.
run_sql -c "update public.agh_handoff_records set submitted_at=now()-interval '2 days' where id='cccccccc-0000-0000-0000-0000000000c5';" >/dev/null
assert_eq "safe_requeue_releases_only_pure_fit" "$(run_sql -c "select public.agh_fit_rejection_requeue(true)->>'requeued';")" "1"
assert_eq "safe_requeue_idempotent" "$(run_sql -c "select public.agh_fit_rejection_requeue(true)->>'requeued';")" "0"
assert_eq "mixed_rejection_preserved" "$(run_sql -c "select queue_state from public.agh_handoff_records where id='cccccccc-0000-0000-0000-0000000000c3';")" "REJECTED_BY_GROK"
assert_eq "legacy_single_fit_reason" "$(run_sql -c "select public.agh_fit_requeue_reason_safe('{}', 'FAILED — DNA_LANE_MISMATCH Meditate hip_hop_rap only; lane=rap_trap_hype');")" "t"
assert_eq "legacy_mixed_reason_held" "$(run_sql -c "select public.agh_fit_requeue_reason_safe('{}', 'FAILED — DNA_LANE_MISMATCH Meditate hip_hop_rap only; lane=rap_trap_hype; LOW_REACH');")" "f"
assert_eq "cooldown_helper_not_public" "$(run_sql -c "select has_function_privilege('authenticated', 'public.agh_requeue_contact_cooldown(text,uuid)', 'execute');")" "f"
# Explicit re-review clears an indefinite defer while retaining history.
run_sql -c "update public.agh_handoff_records set packet=packet || '{\"review_defer\":{}}'::jsonb where id='cccccccc-0000-0000-0000-0000000000c1'; select public.agh_review_handoff_records((select batch_id from public.agh_handoff_records where id='cccccccc-0000-0000-0000-0000000000c1'), '[{\"record_id\":\"cccccccc-0000-0000-0000-0000000000c1\",\"decision\":\"reviewed\"}]', 'grok_playlist_control', 'grok_playlist_control');" >/dev/null
assert_eq "explicit_review_resolves_defer" "$(run_sql -c "select (packet ? 'review_defer')::text || ':' || queue_state from public.agh_handoff_records where id='cccccccc-0000-0000-0000-0000000000c1';")" "false:GROK_REVIEWED"


echo "==> PASS: daily-ops migrations applied + authoritative RPC assertions verified"
