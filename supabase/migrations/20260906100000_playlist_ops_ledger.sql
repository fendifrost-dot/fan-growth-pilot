-- Playlist operations ledger: one row per track × playlist target (or campaign).
-- Attribution columns are written by the edge API from authenticated OpsActor only.
-- APPLY via Lovable SQL Editor (paste). Idempotent.

begin;

create table if not exists public.playlist_ops_ledger (
  id uuid primary key default gen_random_uuid(),
  track_id uuid not null references public.tracks(id) on delete cascade,
  playlist_target_id uuid,
  campaign_id uuid,
  approved_song_dna_version_id uuid,
  discovery_source text,
  discovery_date date,
  discovered_by text,
  discovered_by_label text,
  discovered_at timestamptz,
  verification_result text,
  verified_by text,
  verified_by_label text,
  verified_at timestamptz,
  draft_id text,
  drafted_by text,
  drafted_by_label text,
  drafted_at timestamptz,
  approval_result text,
  approved_by text,
  approved_by_label text,
  approved_at timestamptz,
  send_result text,
  sent_by text,
  sent_by_label text,
  sent_at timestamptz,
  email_message_id text,
  email_thread_id text,
  response_status text,
  response_draft text,
  response_sent_at timestamptz,
  last_inbox_check_at timestamptz,
  next_response_check_at timestamptz,
  response_checked_by text,
  response_checked_by_label text,
  placement_status text,
  placement_evidence jsonb,
  last_placement_check_at timestamptz,
  next_placement_check_at timestamptz,
  placement_checked_by text,
  placement_checked_by_label text,
  incident_id uuid,
  rejection_or_shortfall_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists playlist_ops_ledger_track_idx
  on public.playlist_ops_ledger (track_id, updated_at desc);
create index if not exists playlist_ops_ledger_target_idx
  on public.playlist_ops_ledger (playlist_target_id);
create index if not exists playlist_ops_ledger_campaign_idx
  on public.playlist_ops_ledger (campaign_id);
create index if not exists playlist_ops_ledger_next_response_idx
  on public.playlist_ops_ledger (next_response_check_at);
create index if not exists playlist_ops_ledger_next_placement_idx
  on public.playlist_ops_ledger (next_placement_check_at);

comment on table public.playlist_ops_ledger is
  'AGH playlist ops ledger: discovery → verify → draft → approve → send → reply → placement.';
comment on column public.playlist_ops_ledger.placement_evidence is
  'Explicit placement evidence object. Never infer placement from Spotify stream thresholds alone.';

alter table public.playlist_ops_ledger enable row level security;

drop policy if exists "Authenticated read playlist_ops_ledger" on public.playlist_ops_ledger;
create policy "Authenticated read playlist_ops_ledger"
  on public.playlist_ops_ledger for select to authenticated using (true);

drop policy if exists "Service role manages playlist_ops_ledger" on public.playlist_ops_ledger;
create policy "Service role manages playlist_ops_ledger"
  on public.playlist_ops_ledger for all to service_role using (true) with check (true);

drop policy if exists "Deny anon playlist_ops_ledger" on public.playlist_ops_ledger;
create policy "Deny anon playlist_ops_ledger"
  on public.playlist_ops_ledger for all to anon using (false);

grant select on public.playlist_ops_ledger to authenticated;
grant all on public.playlist_ops_ledger to service_role;

commit;
