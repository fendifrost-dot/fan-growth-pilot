-- Track sync-gate columns. sync_eligible is NEVER inferred from has_sample.
-- Application recomputeTrackSyncEligible writes sync_eligible from these
-- explicit Fendi / ops flags + approved Song DNA (+ private license for Neva).
--
-- APPLY via Lovable SQL Editor (paste). Idempotent.

begin;

alter table public.tracks
  add column if not exists approved_song_dna_version_id uuid,
  add column if not exists sample_declaration_approved_at timestamptz,
  add column if not exists sample_declaration_approved_by uuid,
  add column if not exists sync_approved_at timestamptz,
  add column if not exists sync_approved_by uuid,
  add column if not exists splits_ready boolean not null default false,
  add column if not exists publishing_ready boolean not null default false,
  add column if not exists assets_ready boolean not null default false,
  add column if not exists unresolved_rights_exception boolean not null default false,
  add column if not exists sample_exception_resolved boolean not null default false,
  add column if not exists sync_eligible_blockers text[] not null default '{}',
  add column if not exists sync_eligible_computed_at timestamptz;

do $$
begin
  if to_regclass('public.song_dna_versions') is null then
    raise notice 'song_dna_versions absent — approved_song_dna_version_id FK deferred';
  else
    alter table public.tracks
      drop constraint if exists tracks_approved_song_dna_version_id_fkey;
    alter table public.tracks
      add constraint tracks_approved_song_dna_version_id_fkey
      foreign key (approved_song_dna_version_id)
      references public.song_dna_versions(id)
      on delete set null;
  end if;
end$$;

comment on column public.tracks.approved_song_dna_version_id is
  'Pointer to Fendi-approved Song DNA version used by sync gate. Set on DNA approve.';
comment on column public.tracks.sample_declaration_approved_at is
  'Fendi approval timestamp for sample declaration — required for sync_eligible.';
comment on column public.tracks.sync_approved_at is
  'Fendi sync approval timestamp — required for sync_eligible. Never set from has_sample.';
comment on column public.tracks.sync_eligible_blockers is
  'Last recompute blockers from evaluateSyncReady. Empty when sync_eligible is true.';

update public.tracks
set sync_eligible = false
where sync_eligible is distinct from false;

commit;
