#!/usr/bin/env bash
# Apply daily-ops migrations against local PostgreSQL with rollback on failure.
# Usage: bash scripts/test-daily-ops-migrations.sh
# Env:
#   AGH_MIGTEST_USE_SUDO=1  — wrap via `sudo -u postgres` (default for local unix socket)
#   PGHOST / PGUSER / PGPASSWORD — for CI Postgres service (set AGH_MIGTEST_USE_SUDO=0)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB_NAME="agh_daily_ops_migtest"
export PGUSER="${PGUSER:-postgres}"
export PGHOST="${PGHOST:-/var/run/postgresql}"

# Default to sudo peer-auth when talking to a local cluster socket.
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
    sudo -u postgres psql -v ON_ERROR_STOP=1 -d "${DB_NAME}" "$@"
  else
    psql -v ON_ERROR_STOP=1 -d "${DB_NAME}" "$@"
  fi
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
run_sql <<'SQL'
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
  if ! run_sql -f "$file"; then
    echo "FAIL: $(basename "$file") — rolling back by dropping database"
    psql_admin -c "DROP DATABASE IF EXISTS ${DB_NAME};" || true
    exit 1
  fi
}

apply_with_rollback "$ROOT/supabase/migrations/20260907000000_daily_ops_multichannel_sync_intake.sql"
apply_with_rollback "$ROOT/supabase/migrations/20260907010000_daily_ops_pr19_security_amendment.sql"
apply_with_rollback "$ROOT/supabase/migrations/20260907020000_daily_ops_operational_chain.sql"

echo "==> Preflight orphan report"
run_sql -c "select * from public.agh_daily_ops_fk_preflight();"

echo "==> Atomic handoff RPC conflict test"
run_sql <<'SQL'
insert into public.tracks (id, name) values ('11111111-1111-1111-1111-111111111111', 'Test Track');
insert into public.song_dna_versions (id, track_id, approval_state, approved_lanes, short_pitch)
values ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'approved', array['rap_general'], 'pitch');
update public.tracks set approved_song_dna_version_id = '22222222-2222-2222-2222-222222222222'
 where id = '11111111-1111-1111-1111-111111111111';

insert into public.agh_handoff_batches (id, batch_kind, queue_state, track_id, song_dna_version_id, discovered_by, discovered_by_label)
values ('33333333-3333-3333-3333-333333333333', 'playlist', 'CLAUDE_BATCH_READY',
        '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
        'claude', 'claude');

-- Happy path
select public.advance_agh_handoff_batch(
  '33333333-3333-3333-3333-333333333333',
  'CLAUDE_BATCH_READY',
  'CLAUDE_PLAYLIST_COMPLETE',
  '{"drafted_by":"claude","drafted_by_label":"claude"}'::jsonb
) ->> 'ok' as ok1;

-- Conflict: wrong expected state
select public.advance_agh_handoff_batch(
  '33333333-3333-3333-3333-333333333333',
  'CLAUDE_BATCH_READY',
  'AWAITING_GROK_REVIEW',
  '{}'::jsonb
) ->> 'code' as conflict_code;
SQL

echo "==> PASS: daily-ops migrations applied + RPC conflict verified"
