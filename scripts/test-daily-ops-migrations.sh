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
apply_with_rollback "$ROOT/supabase/migrations/20260907150000_mcp_inventory_atomic_consistency.sql"

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

DRAFT_N=$(run_sql -c "select count(*) from public.outreach_drafts;")
REC_N=$(run_sql -c "select count(*) from public.agh_handoff_records;")
BATCH_N=$(run_sql -c "select count(*) from public.agh_handoff_batches where id <> '33333333-3333-3333-3333-333333333333';")
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

echo "==> PASS: daily-ops migrations applied + authoritative RPC assertions verified"
