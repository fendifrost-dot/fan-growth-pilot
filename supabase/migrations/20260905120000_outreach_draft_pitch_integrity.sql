-- Pitch-copy integrity on outreach drafts + send ledger fields.
-- Apply via Lovable SQL Editor (paste, don't type). Do not apply via supabase CLI.
--
-- Stale approved drafts (e.g. Meditate still carrying old house copy) must be
-- regenerated — execute-pitch compares pitch_copy_hash / body containment and
-- refuses mismatches. This migration only adds columns; it does not mutate drafts.

-- ---------------------------------------------------------------------------
-- Draft artefact provenance (what Grok approved was built from)
-- ---------------------------------------------------------------------------
alter table public.outreach_drafts
  add column if not exists pitch_copy_source text,
  add column if not exists pitch_copy_hash text,
  add column if not exists template_id uuid references public.pitch_templates(id) on delete set null;

comment on column public.outreach_drafts.pitch_copy_source is
  'Which field supplied {{pitch}} at draft time (song_dna_versions.short_pitch | tracks.short_pitch).';
comment on column public.outreach_drafts.pitch_copy_hash is
  'SHA-256 of normalized resolved pitch string at draft time; send refuses on mismatch.';
comment on column public.outreach_drafts.template_id is
  'pitch_templates row used to render subject/body at draft time.';

create index if not exists outreach_drafts_pitch_copy_hash_idx
  on public.outreach_drafts (pitch_copy_hash)
  where pitch_copy_hash is not null;

create index if not exists outreach_drafts_status_track_idx
  on public.outreach_drafts (status, track_id);

-- ---------------------------------------------------------------------------
-- Send ledger: what the backend actually dispatched
-- ---------------------------------------------------------------------------
alter table public.pitch_log
  add column if not exists draft_id uuid references public.outreach_drafts(id) on delete set null,
  add column if not exists pitch_copy_source text,
  add column if not exists pitch_copy_hash text,
  add column if not exists dispatched_via text;

comment on column public.pitch_log.draft_id is
  'Approved outreach_drafts row whose exact recipient/subject/body were dispatched.';
comment on column public.pitch_log.pitch_copy_source is
  'Resolved pitch source recorded on the approved draft at send time.';
comment on column public.pitch_log.pitch_copy_hash is
  'Pitch hash verified at send time against the live track/DNA copy.';
comment on column public.pitch_log.dispatched_via is
  'Sender route that dispatched (execute-pitch | send-pitch-email).';

create index if not exists pitch_log_draft_id_idx on public.pitch_log (draft_id);
