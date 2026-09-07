-- PR #19 security / integrity amendment (never apply the prior migration alone).
-- Fixes: foreign keys, completed_by attribution columns, discovery_profile FKs.
-- Idempotent. Apply via Lovable SQL Editor after (or together with) 20260907000000.

begin;

-- Station run attribution: preserve original actor; stamp resume/complete separately
alter table public.daily_ops_station_runs
  add column if not exists completed_by text,
  add column if not exists completed_by_label text,
  add column if not exists last_resumed_by text,
  add column if not exists last_resumed_by_label text,
  add column if not exists last_resumed_at timestamptz;

-- Batch FK continuity (input/output batches)
do $$ begin
  alter table public.daily_ops_station_runs
    add constraint daily_ops_station_runs_input_batch_fkey
    foreign key (input_batch_id) references public.agh_handoff_batches(id) on delete set null;
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.daily_ops_station_runs
    add constraint daily_ops_station_runs_output_batch_fkey
    foreign key (output_batch_id) references public.agh_handoff_batches(id) on delete set null;
exception when duplicate_object then null; end $$;

-- Handoff record → playlist target / song DNA / sync entities
do $$ begin
  alter table public.agh_handoff_batches
    add constraint agh_handoff_batches_song_dna_fkey
    foreign key (song_dna_version_id) references public.song_dna_versions(id) on delete set null;
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.agh_handoff_records
    add constraint agh_handoff_records_playlist_target_fkey
    foreign key (playlist_target_id) references public.playlist_targets(playlist_id) on delete set null;
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.agh_handoff_records
    add constraint agh_handoff_records_song_dna_fkey
    foreign key (song_dna_version_id) references public.song_dna_versions(id) on delete set null;
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.agh_handoff_records
    add constraint agh_handoff_records_sync_target_fkey
    foreign key (sync_target_id) references public.sync_research_targets(id) on delete set null;
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.agh_handoff_records
    add constraint agh_handoff_records_sync_opportunity_fkey
    foreign key (sync_opportunity_id) references public.sync_research_opportunities(id) on delete set null;
exception when duplicate_object then null; end $$;

-- Playlist target DNA / discovery profile FKs
do $$ begin
  alter table public.playlist_targets
    add constraint playlist_targets_song_dna_fkey
    foreign key (song_dna_version_id) references public.song_dna_versions(id) on delete set null;
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.playlist_targets
    add constraint playlist_targets_discovery_profile_fkey
    foreign key (discovery_profile_id) references public.discovery_profiles(id) on delete set null;
exception when duplicate_object then null; end $$;

-- Sync research DNA / profile FKs
do $$ begin
  alter table public.sync_research_targets
    add constraint sync_research_targets_song_dna_fkey
    foreign key (song_dna_version_id) references public.song_dna_versions(id) on delete set null;
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.sync_research_targets
    add constraint sync_research_targets_discovery_profile_fkey
    foreign key (discovery_profile_id) references public.discovery_profiles(id) on delete set null;
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.sync_research_opportunities
    add constraint sync_research_opportunities_song_dna_fkey
    foreign key (song_dna_version_id) references public.song_dna_versions(id) on delete set null;
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.sync_research_pitch_drafts
    add constraint sync_research_pitch_drafts_song_dna_fkey
    foreign key (song_dna_version_id) references public.song_dna_versions(id) on delete set null;
exception when duplicate_object then null; end $$;

-- playlist_ops_ledger DNA FK
do $$ begin
  alter table public.playlist_ops_ledger
    add constraint playlist_ops_ledger_song_dna_fkey
    foreign key (approved_song_dna_version_id) references public.song_dna_versions(id) on delete set null;
exception when duplicate_object then null; end $$;

comment on column public.daily_ops_station_runs.completed_by is
  'Authenticated actor that completed the run — original actor_kind is preserved on resume.';

commit;