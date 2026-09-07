-- Operational chain amendment: track-bound DNA columns, Grok stations,
-- atomic handoff RPC, preflight orphan report, manual-submit stamps.
-- Apply via Lovable SQL Editor AFTER 20260907000000 + 20260907010000.
-- Do NOT apply until PR review authorizes production deploy.

begin;

-- ---------------------------------------------------------------------------
-- 1. Expand station IDs (Claude discovery + Grok review/send)
-- ---------------------------------------------------------------------------
alter table public.daily_ops_station_runs
  drop constraint if exists daily_ops_station_runs_station_id_check;

alter table public.daily_ops_station_runs
  add constraint daily_ops_station_runs_station_id_check
  check (station_id in (
    'playlist_discovery_begin',
    'playlist_tranche_first',
    'playlist_tranche_final',
    'sync_batch_ready',
    'grok_playlist_review',
    'grok_playlist_send'
  ));

alter table public.daily_ops_station_runs
  add column if not exists owner_kind text,
  add column if not exists required_upstream_queue_state text;

-- ---------------------------------------------------------------------------
-- 2. Handoff records: song-bound track identity (not playlist_targets DNA)
-- ---------------------------------------------------------------------------
alter table public.agh_handoff_batches
  add column if not exists track_id uuid;

alter table public.agh_handoff_records
  add column if not exists track_id uuid,
  add column if not exists submitted_at timestamptz,
  add column if not exists submitted_by text,
  add column if not exists submitted_by_label text,
  add column if not exists manual_submit_channel text
    check (manual_submit_channel is null or manual_submit_channel in ('web_form', 'instagram_dm', 'email')),
  add column if not exists manual_submit_result text;

do $$ begin
  alter table public.agh_handoff_batches
    add constraint agh_handoff_batches_track_fkey
    foreign key (track_id) references public.tracks(id) on delete set null;
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.agh_handoff_records
    add constraint agh_handoff_records_track_fkey
    foreign key (track_id) references public.tracks(id) on delete set null;
exception when duplicate_object then null; end $$;

create index if not exists agh_handoff_records_track_idx
  on public.agh_handoff_records (track_id);

-- ---------------------------------------------------------------------------
-- 2b. Preflight orphan report (AFTER track_id columns exist; inspect before live FKs)
-- ---------------------------------------------------------------------------
create or replace function public.agh_daily_ops_fk_preflight()
returns table(check_name text, orphan_count bigint, sample_ids text)
language sql
stable
as $$
  select 'handoff_records_missing_track'::text,
         count(*)::bigint,
         string_agg(id::text, ',' order by created_at desc)
  from (
    select id, created_at from public.agh_handoff_records
    where track_id is null
    limit 20
  ) s
  union all
  select 'handoff_song_dna_not_in_versions',
         (select count(*) from public.agh_handoff_records r
           where r.song_dna_version_id is not null
             and not exists (
               select 1 from public.song_dna_versions d where d.id = r.song_dna_version_id
             )),
         null
  union all
  select 'station_runs_bad_input_batch',
         (select count(*) from public.daily_ops_station_runs r
           where r.input_batch_id is not null
             and not exists (
               select 1 from public.agh_handoff_batches b where b.id = r.input_batch_id
             )),
         null
  union all
  select 'station_runs_bad_output_batch',
         (select count(*) from public.daily_ops_station_runs r
           where r.output_batch_id is not null
             and not exists (
               select 1 from public.agh_handoff_batches b where b.id = r.output_batch_id
             )),
         null;
$$;

comment on function public.agh_daily_ops_fk_preflight() is
  'Read-only orphan report before/after daily-ops FK enforcement. Inspect before live apply.';

-- ---------------------------------------------------------------------------
-- 3. Atomic compare-and-set handoff transition (batch + records together)
-- ---------------------------------------------------------------------------
create or replace function public.advance_agh_handoff_batch(
  p_batch_id uuid,
  p_expected_state text,
  p_next_state text,
  p_stamps jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch public.agh_handoff_batches%rowtype;
  v_updated int;
begin
  if p_batch_id is null or p_expected_state is null or p_next_state is null then
    return jsonb_build_object('ok', false, 'code', 'bad_request', 'error', 'batch_id and states required');
  end if;

  update public.agh_handoff_batches b
     set queue_state = p_next_state,
         updated_at = now(),
         drafted_by = coalesce(p_stamps->>'drafted_by', b.drafted_by),
         drafted_by_label = coalesce(p_stamps->>'drafted_by_label', b.drafted_by_label),
         reviewed_by = coalesce(p_stamps->>'reviewed_by', b.reviewed_by),
         reviewed_by_label = coalesce(p_stamps->>'reviewed_by_label', b.reviewed_by_label),
         approved_by = coalesce(p_stamps->>'approved_by', b.approved_by),
         approved_by_label = coalesce(p_stamps->>'approved_by_label', b.approved_by_label),
         rejected_by = coalesce(p_stamps->>'rejected_by', b.rejected_by),
         rejected_by_label = coalesce(p_stamps->>'rejected_by_label', b.rejected_by_label),
         notes = coalesce(p_stamps->>'notes', b.notes)
   where b.id = p_batch_id
     and b.queue_state = p_expected_state
  returning * into v_batch;

  if not found then
    return jsonb_build_object(
      'ok', false,
      'code', 'conflict',
      'error', 'queue_state changed by another request or batch missing',
      'expected', p_expected_state,
      'attempted', p_next_state
    );
  end if;

  update public.agh_handoff_records r
     set queue_state = p_next_state,
         updated_at = now(),
         reviewed_by = coalesce(p_stamps->>'reviewed_by', r.reviewed_by),
         reviewed_by_label = coalesce(p_stamps->>'reviewed_by_label', r.reviewed_by_label),
         approved_by = coalesce(p_stamps->>'approved_by', r.approved_by),
         approved_by_label = coalesce(p_stamps->>'approved_by_label', r.approved_by_label),
         rejected_by = coalesce(p_stamps->>'rejected_by', r.rejected_by),
         rejected_by_label = coalesce(p_stamps->>'rejected_by_label', r.rejected_by_label)
   where r.batch_id = p_batch_id;

  get diagnostics v_updated = row_count;

  return jsonb_build_object(
    'ok', true,
    'batch', to_jsonb(v_batch),
    'records_updated', v_updated
  );
end;
$$;

revoke all on function public.advance_agh_handoff_batch(uuid, text, text, jsonb) from public;
grant execute on function public.advance_agh_handoff_batch(uuid, text, text, jsonb) to service_role;
grant execute on function public.advance_agh_handoff_batch(uuid, text, text, jsonb) to authenticated;

-- Update ops_settings station schedule to include Grok stations
insert into public.ops_settings (setting_key, setting_value, description) values
  (
    'daily_stations',
    jsonb_build_object(
      'timezone', 'America/Chicago',
      'stations', jsonb_build_array(
        jsonb_build_object('id', 'playlist_discovery_begin', 'local_time', '04:30', 'owner', 'claude', 'label', 'Playlist discovery begins'),
        jsonb_build_object('id', 'playlist_tranche_first', 'local_time', '07:00', 'owner', 'claude', 'label', 'First playlist tranche ready'),
        jsonb_build_object('id', 'playlist_tranche_final', 'local_time', '08:30', 'owner', 'claude', 'label', 'Final playlist tranche + sync discovery'),
        jsonb_build_object('id', 'sync_batch_ready', 'local_time', '12:00', 'owner', 'claude', 'label', 'Sync batch ready'),
        jsonb_build_object('id', 'grok_playlist_review', 'local_time', '13:00', 'owner', 'grok_playlist_control', 'label', 'Grok playlist review', 'requires_upstream_queue_state', 'CLAUDE_PLAYLIST_COMPLETE'),
        jsonb_build_object('id', 'grok_playlist_send', 'local_time', '15:00', 'owner', 'grok_playlist_control', 'label', 'Grok approved send', 'requires_upstream_queue_state', 'APPROVED_FOR_SEND')
      ),
      'scheduler_note', 'OUTREACH_SCHEDULER_SECRET may start Claude stations only; completion requires Claude credential. Grok stations require GROK_PLAYLIST_CONTROL_SECRET or Fendi.'
    ),
    'Claude + Grok station schedule — America/Chicago. Approval cannot front-run CLAUDE_PLAYLIST_COMPLETE.'
  )
on conflict (setting_key) do update
  set setting_value = excluded.setting_value,
      description = excluded.description,
      updated_at = now();

commit;