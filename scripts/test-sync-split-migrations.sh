#!/usr/bin/env bash
# Apply sync + authoritative split-sheet migrations against local PostgreSQL
# and assert live constraints/triggers (not SQL text).
# Usage: bash scripts/test-sync-split-migrations.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB_NAME="agh_sync_split_migtest"
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

echo "==> Stub prerequisite schema"
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
create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
create or replace function public.has_role(uid uuid, role text)
returns boolean language sql stable as $$ select true $$;

create schema if not exists storage;
create table if not exists storage.buckets (
  id text primary key,
  name text,
  public boolean default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text,
  name text
);
alter table storage.objects enable row level security;

create table public.tracks (
  id uuid primary key default gen_random_uuid(),
  name text,
  status text not null default 'active',
  approved_song_dna_version_id uuid,
  sync_eligible boolean default false,
  has_sample text,
  updated_at timestamptz default now()
);

create table public.song_dna_versions (
  id uuid primary key default gen_random_uuid(),
  track_id uuid not null references public.tracks(id),
  approval_state text not null default 'draft'
);

create table public.ops_settings (
  setting_key text primary key,
  setting_value jsonb not null default '{}'::jsonb,
  description text,
  updated_by text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table public.daily_ops_station_runs (
  id uuid primary key default gen_random_uuid(),
  station_id text
);

create table public.agh_handoff_batches (
  id uuid primary key default gen_random_uuid(),
  batch_kind text not null default 'sync',
  queue_state text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table public.sync_research_targets (
  id uuid primary key default gen_random_uuid(),
  official_url text,
  source_url text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table public.sync_research_opportunities (
  id uuid primary key default gen_random_uuid(),
  source_url text,
  primary_source_url text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table public.sync_research_pitch_drafts (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid references public.sync_research_opportunities(id) on delete cascade,
  track_id uuid not null references public.tracks(id) on delete cascade,
  body text not null default '',
  status text not null default 'draft',
  drafted_by text not null default 'test',
  drafted_by_label text not null default 'test',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.agh_mcp_oauth_clients (
  client_id text primary key
);

create table public.agh_mcp_oauth_codes (
  code_hash text primary key,
  client_id text,
  redirect_uri text,
  code_challenge text,
  scope text,
  authorized_by_user_id uuid,
  expires_at timestamptz
);

create table public.agh_mcp_oauth_tokens (
  token_hash text primary key,
  refresh_token_hash text unique,
  client_id text,
  scope text,
  actor_kind text not null default 'claude_playlist_discovery'
    check (actor_kind = 'claude_playlist_discovery'),
  authorized_by_user_id uuid,
  expires_at timestamptz,
  refresh_expires_at timestamptz,
  revoked_at timestamptz
);

create table public.split_sheets (
  id uuid primary key default gen_random_uuid(),
  track_id uuid not null references public.tracks(id),
  version_number int not null default 1,
  status text not null default 'draft',
  title text,
  notes text,
  action_items jsonb not null default '[]'::jsonb,
  generated_html text,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.split_sheet_contributors (
  id uuid primary key default gen_random_uuid(),
  split_sheet_id uuid not null references public.split_sheets(id) on delete cascade,
  legal_name text,
  role text,
  split_percent numeric,
  ipi_number text,
  pro_affiliation text,
  notes text,
  sort_order int default 0,
  created_at timestamptz default now()
);
SQL

apply_with_rollback() {
  local file="$1"
  echo "==> Applying $(basename "$file")"
  if ! run_sql_pretty -f "$file"; then
    echo "FAIL: $(basename "$file")"
    psql_admin -c "DROP DATABASE IF EXISTS ${DB_NAME};" || true
    exit 1
  fi
}

apply_with_rollback "$ROOT/supabase/migrations/20260911150000_sync_operating_stack.sql"
apply_with_rollback "$ROOT/supabase/migrations/20260911160000_authoritative_split_sheets.sql"
apply_with_rollback "$ROOT/supabase/migrations/20260912010000_split_sheet_master_owner_immutability.sql"
apply_with_rollback "$ROOT/supabase/migrations/20260913120000_sync_split_delivery_corrections.sql"

echo "==> Catalog assertions"
assert_eq "create_rpc" "$(run_sql -c "select to_regprocedure('public.create_split_sheet_version(uuid, jsonb, jsonb, text, text, boolean, boolean, boolean, text, text, text, text, text)') is not null;")" "t"
assert_eq "finalize_rpc" "$(run_sql -c "select to_regprocedure('public.finalize_split_sheet_version(uuid, text, text, text, text, text, text, text, boolean)') is not null;")" "t"
assert_eq "master_owners_table" "$(run_sql -c "select count(*) from information_schema.tables where table_schema='public' and table_name='split_sheet_master_owners';")" "1"
assert_eq "evidence_table" "$(run_sql -c "select count(*) from information_schema.tables where table_schema='public' and table_name='split_sheet_evidence';")" "1"
assert_eq "deliveries_table" "$(run_sql -c "select count(*) from information_schema.tables where table_schema='public' and table_name='split_sheet_deliveries';")" "1"
assert_eq "audit_table" "$(run_sql -c "select count(*) from information_schema.tables where table_schema='public' and table_name='rights_document_audit_events';")" "1"
assert_eq "sheet_final_trigger" "$(run_sql -c "select count(*) from pg_trigger where tgname='split_sheets_final_immutable';")" "1"
assert_eq "contrib_trigger" "$(run_sql -c "select count(*) from pg_trigger where tgname='split_sheet_contributors_final_immutable';")" "1"
assert_eq "master_trigger" "$(run_sql -c "select count(*) from pg_trigger where tgname='split_sheet_master_owners_final_immutable';")" "1"
assert_eq "evidence_trigger" "$(run_sql -c "select count(*) from pg_trigger where tgname='split_sheet_evidence_protect_verified';")" "1"
assert_eq "doc_kind_check" "$(run_sql -c "select count(*) from pg_constraint where conname='split_sheets_document_kind_check';")" "1"
assert_eq "delivery_result_check" "$(run_sql -c "select count(*) from pg_constraint where conname='split_sheet_deliveries_delivery_result_check';")" "1"
assert_eq "policy_check" "$(run_sql -c "select count(*) from pg_constraint where conname='tracks_split_sheet_delivery_policy_check';")" "1"
assert_eq "source_check" "$(run_sql -c "select count(*) from pg_constraint where conname='tracks_splits_ready_source_check';")" "1"
assert_eq "private_bucket" "$(run_sql -c "select count(*) from storage.buckets where id='rights-documents' and public=false;")" "1"
assert_eq "legacy_col" "$(run_sql -c "select count(*) from information_schema.columns where table_name='tracks' and column_name='splits_ready_legacy';")" "1"
assert_eq "delivery_idem_idx" "$(run_sql -c "select count(*) from pg_indexes where indexname='split_sheet_deliveries_idempotency_uidx';")" "1"

echo "==> Live trigger/constraint behavior"
run_sql_pretty <<'SQL'
insert into public.tracks (id, name, splits_ready, splits_ready_source)
values ('11111111-1111-1111-1111-111111111111', 'fixture-track', false, 'none');

insert into public.split_sheets (
  id, track_id, version_number, status, is_current, document_kind, document_hash,
  document_storage_path, generated_html, title
) values (
  '22222222-2222-2222-2222-222222222222',
  '11111111-1111-1111-1111-111111111111',
  1, 'final', true, 'agh_generated_summary', 'abc123',
  'rights/fixture.html', '<html>final</html>', 'fixture'
);
SQL

set +e
MUTATE_OUT=$(run_sql_pretty -c "update public.split_sheets set document_hash='mutated' where id='22222222-2222-2222-2222-222222222222';" 2>&1)
MUTATE_RC=$?
set -e
if [[ ${MUTATE_RC} -eq 0 ]]; then
  echo "FAIL: finalized sheet accepted a hash rewrite"
  echo "${MUTATE_OUT}"
  psql_admin -c "DROP DATABASE IF EXISTS ${DB_NAME};" || true
  exit 1
fi
echo "OK assert: final sheet hash mutation rejected"

set +e
CONTRIB_OUT=$(run_sql_pretty -c "insert into public.split_sheet_contributors (split_sheet_id, legal_name, role, split_percent, ownership_side) values ('22222222-2222-2222-2222-222222222222','A','writer',100,'composition');" 2>&1)
CONTRIB_RC=$?
set -e
if [[ ${CONTRIB_RC} -eq 0 ]]; then
  echo "FAIL: finalized sheet accepted contributor insert"
  echo "${CONTRIB_OUT}"
  psql_admin -c "DROP DATABASE IF EXISTS ${DB_NAME};" || true
  exit 1
fi
echo "OK assert: final contributor insert rejected"

set +e
SOURCE_OUT=$(run_sql_pretty -c "update public.tracks set splits_ready_source='not_a_source' where id='11111111-1111-1111-1111-111111111111';" 2>&1)
SOURCE_RC=$?
set -e
if [[ ${SOURCE_RC} -eq 0 ]]; then
  echo "FAIL: invalid splits_ready_source accepted"
  echo "${SOURCE_OUT}"
  psql_admin -c "DROP DATABASE IF EXISTS ${DB_NAME};" || true
  exit 1
fi
echo "OK assert: invalid splits_ready_source rejected"

set +e
KIND_OUT=$(run_sql_pretty -c "insert into public.split_sheets (track_id, status, document_kind, is_current) values ('11111111-1111-1111-1111-111111111111','draft','forged_signed',false);" 2>&1)
KIND_RC=$?
set -e
if [[ ${KIND_RC} -eq 0 ]]; then
  echo "FAIL: forged document_kind accepted"
  echo "${KIND_OUT}"
  psql_admin -c "DROP DATABASE IF EXISTS ${DB_NAME};" || true
  exit 1
fi
echo "OK assert: unknown document_kind rejected"

echo "==> PASS: sync/split migrations applied and live invariants hold"
psql_admin -c "DROP DATABASE IF EXISTS ${DB_NAME};"
