-- Pitch Portal: explicit pitch campaigns
--
-- WHY THIS EXISTS
-- Until now there was no explicit "this song is active for outreach" record.
-- The daily submissions flow inferred pitch scope from catalogue membership
-- (tracks = the full ~12-song catalogue, bulk-imported 2026-07-10) or from the
-- existence of a live smart link. Both are wrong and fragile: an album smart
-- link can drag in songs that were never meant to be pitched, and every new
-- catalogue row silently became pitchable.
--
-- A pitch_campaigns row is a DELIBERATE act by the artist: "pitch this song."
-- No active campaign => the song is never pitched, regardless of caller.
--
-- Chose a separate table over a boolean on tracks (e.g. is_campaigning) so
-- paused/ended campaigns keep their history and final results stay viewable in
-- the portal. A boolean would erase the record the moment a campaign ends.
--
-- smart_link_id is the FIRST real FK between a track and its smart link. Until
-- now that relationship was convention only (matching on title/slug/metadata
-- ->>'spotify_url'). The campaign is the natural place to bind them, because
-- choosing the link to pitch IS part of choosing to pitch the song.
--
-- REVISED 2026-09-02 (docs/PHASE0_LOCKED_DECISIONS.md §8):
-- Campaigns MUST begin as drafts. Default status is 'draft'. Never auto-activate.
-- Apply 20260902000000_pitch_campaigns_activation_gate.sql after this chain.
--
-- Run this in the Lovable SQL Editor.

create table if not exists public.pitch_campaigns (
  id uuid primary key default gen_random_uuid(),
  track_id uuid not null references public.tracks(id) on delete cascade,
  -- Nullable so a half-configured campaign can be saved as 'draft' while the
  -- artist fills in the missing pieces. The create/resume guardrail (enforced
  -- in _shared/pitch-campaigns.ts) requires it to be set before 'active'.
  smart_link_id uuid references public.smart_links(id) on delete set null,
  status text not null default 'draft' check (status in ('draft', 'active', 'paused', 'ended')),
  daily_target integer not null default 20 check (daily_target > 0 and daily_target <= 200),
  notes text,
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A track can have at most one open (active or paused) campaign at a time, but
-- any number of ended ones. This is what makes "is this song pitchable?" a
-- single unambiguous lookup while still keeping full campaign history.
create unique index if not exists pitch_campaigns_one_open_per_track
  on public.pitch_campaigns (track_id)
  where status in ('active', 'paused');

create index if not exists pitch_campaigns_status_idx on public.pitch_campaigns (status);
create index if not exists pitch_campaigns_track_idx on public.pitch_campaigns (track_id);

drop trigger if exists trg_pitch_campaigns_updated_at on public.pitch_campaigns;
create trigger trg_pitch_campaigns_updated_at
  before update on public.pitch_campaigns
  for each row execute function public.touch_updated_at();

-- RLS: follows the backend-table pattern used by pitch_log / playlist_targets /
-- outreach_drafts. This table has no user_id; all access goes through Edge
-- Functions using SUPABASE_SERVICE_ROLE_KEY. Direct client access is denied so
-- the campaign guardrail cannot be bypassed from the browser.
alter table public.pitch_campaigns enable row level security;

drop policy if exists "Service role full access on pitch_campaigns" on public.pitch_campaigns;
create policy "Service role full access on pitch_campaigns"
  on public.pitch_campaigns for all
  to service_role
  using (true)
  with check (true);

drop policy if exists "Deny anonymous access to pitch_campaigns" on public.pitch_campaigns;
create policy "Deny anonymous access to pitch_campaigns"
  on public.pitch_campaigns for all
  to anon
  using (false);

drop policy if exists "Deny authenticated direct access to pitch_campaigns" on public.pitch_campaigns;
create policy "Deny authenticated direct access to pitch_campaigns"
  on public.pitch_campaigns for all
  to authenticated
  using (false);

grant all on public.pitch_campaigns to service_role;

-- NOTE: no backfill. Every campaign must be created deliberately through the
-- Pitch Portal. Seeding one per catalogue track here would recreate exactly the
-- implicit "everything is pitchable" behaviour this table exists to remove.
