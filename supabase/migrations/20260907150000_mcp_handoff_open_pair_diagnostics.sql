-- Open-pair duplicate diagnostics (read-only). Committed separately so a later
-- fail-closed preflight can refuse the unique index WITHOUT rolling back these
-- report/reconcile functions.
-- Apply via Lovable SQL Editor AFTER 20260907140000.
-- Do NOT apply until PR review authorizes production deploy.

begin;

-- ---------------------------------------------------------------------------
-- 1. Handoff open-pair duplicate report + reconcile plan (read-only)
-- ---------------------------------------------------------------------------
create or replace function public.agh_mcp_handoff_open_pair_duplicate_report()
returns table (
  track_id uuid,
  playlist_target_id text,
  submission_channel text,
  song_dna_version_id uuid,
  duplicate_count bigint,
  sample_record_ids uuid[],
  sample_batch_ids uuid[],
  sample_queue_states text[]
)
language sql
stable
security definer
set search_path = public
as $$
  select
    r.track_id,
    r.playlist_target_id,
    r.submission_channel,
    r.song_dna_version_id,
    count(*)::bigint as duplicate_count,
    (array_agg(r.id order by r.created_at))[1:5] as sample_record_ids,
    (array_agg(r.batch_id order by r.created_at))[1:5] as sample_batch_ids,
    (array_agg(r.queue_state order by r.created_at))[1:5] as sample_queue_states
  from public.agh_handoff_records r
  where r.track_id is not null
    and r.playlist_target_id is not null
    and r.submission_channel is not null
    and r.song_dna_version_id is not null
    and r.queue_state not in ('REJECTED_BY_GROK', 'IMPORTED_TO_AGH')
  group by r.track_id, r.playlist_target_id, r.submission_channel, r.song_dna_version_id
  having count(*) > 1
  order by duplicate_count desc, track_id, playlist_target_id;
$$;

revoke all on function public.agh_mcp_handoff_open_pair_duplicate_report() from public, anon, authenticated;
grant execute on function public.agh_mcp_handoff_open_pair_duplicate_report() to service_role;

-- Deterministic reconciliation plan for human review — does NOT mutate data.
create or replace function public.agh_mcp_handoff_open_pair_reconcile_plan()
returns table (
  keep_record_id uuid,
  retire_record_id uuid,
  track_id uuid,
  playlist_target_id text,
  submission_channel text,
  song_dna_version_id uuid,
  keep_created_at timestamptz,
  retire_created_at timestamptz,
  suggested_action text
)
language sql
stable
security definer
set search_path = public
as $$
  with ranked as (
    select
      r.*,
      row_number() over (
        partition by r.track_id, r.playlist_target_id, r.submission_channel, r.song_dna_version_id
        order by r.created_at asc, r.id asc
      ) as rn
    from public.agh_handoff_records r
    where r.track_id is not null
      and r.playlist_target_id is not null
      and r.submission_channel is not null
      and r.song_dna_version_id is not null
      and r.queue_state not in ('REJECTED_BY_GROK', 'IMPORTED_TO_AGH')
  ),
  keepers as (
    select * from ranked where rn = 1
  )
  select
    k.id as keep_record_id,
    d.id as retire_record_id,
    d.track_id,
    d.playlist_target_id,
    d.submission_channel,
    d.song_dna_version_id,
    k.created_at as keep_created_at,
    d.created_at as retire_created_at,
    'REVIEW: keep earliest open record; mark later duplicate REJECTED_BY_GROK or merge after operator ack — do not auto-delete'::text
      as suggested_action
  from ranked d
  join keepers k
    on k.track_id = d.track_id
   and k.playlist_target_id = d.playlist_target_id
   and k.submission_channel = d.submission_channel
   and k.song_dna_version_id = d.song_dna_version_id
  where d.rn > 1
  order by d.track_id, d.playlist_target_id, d.created_at;
$$;

revoke all on function public.agh_mcp_handoff_open_pair_reconcile_plan() from public, anon, authenticated;
grant execute on function public.agh_mcp_handoff_open_pair_reconcile_plan() to service_role;


commit;
