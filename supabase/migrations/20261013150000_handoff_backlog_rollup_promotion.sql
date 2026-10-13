-- Playlist handoff backlog: batch rollup, scheduled Claude-ready promotion, review aging.
--
-- Apply via Lovable SQL Editor (paste). Do not run this from the Supabase CLI.
--
-- What applying this file does:
--   1. Replaces batch rollup so APPROVED_FOR_SEND / SENT / IMPORTED_TO_AGH count as
--      decided. A batch no longer stays AWAITING_GROK_REVIEW after every record has
--      been approved, sent, imported, or rejected. Reviewer stamps are copied from
--      the records. Record states are not rewritten. DNA, route, and PLC approval
--      gates inside agh_review_handoff_records are unchanged.
--   2. Allows SENT on agh_handoff_batches (records already allow it) so a batch whose
--      records are sent can leave review. One-time rollup of batches already stuck
--      in AWAITING_GROK_REVIEW / GROK_REVIEWED. Record rows are not rewritten.
--   3. Installs promotion + 7-day aging functions. This file does NOT call them.
--      Preview: select public.agh_promote_claude_ready_batches(true);
--               select public.agh_age_pending_handoff_records(true);
--   4. When pg_cron is installed, schedules hourly maintenance that promotes fresh
--      CLAUDE_BATCH_READY routes (no business-date filter, null dates included) and
--      returns pending records older than 7 days to route re-verification.
--      Stale routes are held, not promoted. Nothing here approves or sends.
--
-- grok_playlist_control remains the only reviewer/sender. muse_ig_receipt is an
-- edge-function actor, not a database role.

begin;

-- ---------------------------------------------------------------------------
-- 1. Rollup target. Mirrors decidedBatchRollupTarget in handoff-queues.ts.
-- ---------------------------------------------------------------------------
create or replace function public.agh_decided_handoff_rollup_target(
  p_total int,
  p_awaiting int,
  p_reviewed int,
  p_rejected int,
  p_approved int,
  p_awaiting_import int,
  p_sent int,
  p_imported int
) returns text
language sql
immutable
set search_path = public
as $$
  select case
    when coalesce(p_total, 0) <= 0 or coalesce(p_awaiting, 0) > 0 then null
    when coalesce(p_reviewed, 0) + coalesce(p_rejected, 0) + coalesce(p_approved, 0)
       + coalesce(p_awaiting_import, 0) + coalesce(p_sent, 0) + coalesce(p_imported, 0)
       <> p_total then null
    when p_rejected = p_total then 'REJECTED_BY_GROK'
    when coalesce(p_reviewed, 0) > 0 then 'GROK_REVIEWED'
    when coalesce(p_approved, 0) > 0 or coalesce(p_awaiting_import, 0) > 0 then 'APPROVED_FOR_SEND'
    when coalesce(p_sent, 0) > 0 and coalesce(p_imported, 0) = 0 then 'SENT'
    when coalesce(p_imported, 0) > 0 and coalesce(p_sent, 0) = 0 then 'IMPORTED_TO_AGH'
    else 'APPROVED_FOR_SEND'
  end;
$$;

comment on function public.agh_decided_handoff_rollup_target(int, int, int, int, int, int, int, int) is
  'Batch label once no record is still AWAITING_GROK_REVIEW. APPROVED_FOR_SEND, SENT, and IMPORTED_TO_AGH are decided. Does not approve records.';

-- Align the batch with its records. Never moves a record. Never approves.
create or replace function public.agh_rollup_decided_handoff_batch(
  p_batch_id uuid,
  p_actor text default null,
  p_actor_label text default null,
  p_apply boolean default true
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch public.agh_handoff_batches%rowtype;
  v_total int;
  v_awaiting int;
  v_reviewed int;
  v_rejected int;
  v_approved int;
  v_awaiting_import int;
  v_sent int;
  v_imported int;
  v_target text;
  v_reviewed_by text;
  v_reviewed_label text;
  v_approved_by text;
  v_approved_label text;
  v_rejected_by text;
  v_rejected_label text;
begin
  if p_batch_id is null then
    return jsonb_build_object('ok', false, 'code', 'bad_request', 'error', 'batch_id required');
  end if;

  select * into v_batch from public.agh_handoff_batches where id = p_batch_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'batch_not_found');
  end if;
  if v_batch.queue_state not in ('AWAITING_GROK_REVIEW', 'GROK_REVIEWED') then
    return jsonb_build_object('ok', true, 'changed', false, 'batch_id', p_batch_id,
      'batch_queue_state', v_batch.queue_state, 'reason', 'not_in_review');
  end if;

  select count(*),
         count(*) filter (where queue_state = 'AWAITING_GROK_REVIEW'),
         count(*) filter (where queue_state = 'GROK_REVIEWED'),
         count(*) filter (where queue_state = 'REJECTED_BY_GROK'),
         count(*) filter (where queue_state = 'APPROVED_FOR_SEND'),
         count(*) filter (where queue_state = 'AWAITING_AGH_IMPORT'),
         count(*) filter (where queue_state = 'SENT'),
         count(*) filter (where queue_state = 'IMPORTED_TO_AGH')
    into v_total, v_awaiting, v_reviewed, v_rejected, v_approved, v_awaiting_import, v_sent, v_imported
    from public.agh_handoff_records
   where batch_id = p_batch_id;

  v_target := public.agh_decided_handoff_rollup_target(
    v_total, v_awaiting, v_reviewed, v_rejected, v_approved, v_awaiting_import, v_sent, v_imported);

  select
    (array_agg(reviewed_by order by updated_at desc) filter (where nullif(reviewed_by, '') is not null))[1],
    (array_agg(reviewed_by_label order by updated_at desc) filter (where nullif(reviewed_by_label, '') is not null))[1],
    (array_agg(approved_by order by updated_at desc) filter (where nullif(approved_by, '') is not null))[1],
    (array_agg(approved_by_label order by updated_at desc) filter (where nullif(approved_by_label, '') is not null))[1],
    (array_agg(rejected_by order by updated_at desc) filter (where nullif(rejected_by, '') is not null))[1],
    (array_agg(rejected_by_label order by updated_at desc) filter (where nullif(rejected_by_label, '') is not null))[1]
    into v_reviewed_by, v_reviewed_label, v_approved_by, v_approved_label, v_rejected_by, v_rejected_label
    from public.agh_handoff_records
   where batch_id = p_batch_id;

  v_reviewed_by := coalesce(nullif(v_batch.reviewed_by, ''), nullif(p_actor, ''), v_reviewed_by, v_approved_by, v_rejected_by);
  v_reviewed_label := coalesce(nullif(v_batch.reviewed_by_label, ''), nullif(p_actor_label, ''), v_reviewed_label, v_approved_label, v_rejected_label, v_reviewed_by);
  if v_target in ('APPROVED_FOR_SEND', 'AWAITING_AGH_IMPORT', 'SENT', 'IMPORTED_TO_AGH') then
    v_approved_by := coalesce(nullif(v_batch.approved_by, ''), v_approved_by);
    v_approved_label := coalesce(nullif(v_batch.approved_by_label, ''), v_approved_label, v_approved_by);
  else
    v_approved_by := v_batch.approved_by;
    v_approved_label := v_batch.approved_by_label;
  end if;
  if v_target = 'REJECTED_BY_GROK' then
    v_rejected_by := coalesce(nullif(v_batch.rejected_by, ''), v_rejected_by, v_reviewed_by);
    v_rejected_label := coalesce(nullif(v_batch.rejected_by_label, ''), v_rejected_label, v_rejected_by);
  else
    v_rejected_by := v_batch.rejected_by;
    v_rejected_label := v_batch.rejected_by_label;
  end if;

  if v_target is null then
    return jsonb_build_object('ok', true, 'changed', false, 'batch_id', p_batch_id,
      'batch_queue_state', v_batch.queue_state, 'reason', 'records_still_pending_or_empty');
  end if;

  if not p_apply then
    return jsonb_build_object(
      'ok', true, 'changed', false, 'dry_run', true, 'batch_id', p_batch_id,
      'from_status', v_batch.queue_state, 'to_status', v_target,
      'reviewed_by', v_reviewed_by, 'approved_by', v_approved_by);
  end if;

  if v_target is not distinct from v_batch.queue_state
     and v_reviewed_by is not distinct from v_batch.reviewed_by
     and v_approved_by is not distinct from v_batch.approved_by
     and v_rejected_by is not distinct from v_batch.rejected_by then
    return jsonb_build_object('ok', true, 'changed', false, 'batch_id', p_batch_id,
      'batch_queue_state', v_batch.queue_state, 'reason', 'already_aligned');
  end if;

  update public.agh_handoff_batches
     set queue_state = v_target,
         reviewed_by = v_reviewed_by,
         reviewed_by_label = v_reviewed_label,
         approved_by = v_approved_by,
         approved_by_label = v_approved_label,
         rejected_by = case when v_target = 'REJECTED_BY_GROK' then v_rejected_by else rejected_by end,
         rejected_by_label = case when v_target = 'REJECTED_BY_GROK' then v_rejected_label else rejected_by_label end,
         notes = case
           when v_target = 'REJECTED_BY_GROK'
             then coalesce(notes, 'All records rejected at record level (see each record''s rejection_reason).')
           else notes
         end,
         updated_at = now()
   where id = p_batch_id
     and queue_state = v_batch.queue_state;

  return jsonb_build_object(
    'ok', true, 'changed', true, 'batch_id', p_batch_id,
    'from_status', v_batch.queue_state, 'to_status', v_target,
    'reviewed_by', v_reviewed_by, 'approved_by', v_approved_by);
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. agh_review_handoff_records — same decisions and gates. Rollup delegates
--    to agh_rollup_decided_handoff_batch so approved/sent/imported records
--    close the batch. PLC (and Fendi) remain the only approvers.
-- ---------------------------------------------------------------------------
create or replace function public.agh_review_handoff_records(
  p_batch_id uuid,
  p_decisions jsonb,
  p_actor text,
  p_actor_label text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch public.agh_handoff_batches%rowtype;
  v_item jsonb;
  v_rec public.agh_handoff_records%rowtype;
  v_dec text;
  v_codes jsonb;
  v_reason text;
  v_text text;
  v_hist jsonb;
  v_applied jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_counts jsonb;
  v_policy jsonb;
begin
  if p_batch_id is null or p_decisions is null or jsonb_typeof(p_decisions) <> 'array' then
    return jsonb_build_object('ok', false, 'code', 'bad_request', 'error', 'batch_id and decisions array required');
  end if;
  if coalesce(p_actor, '') = '' then
    return jsonb_build_object('ok', false, 'code', 'bad_request', 'error', 'actor required');
  end if;

  select * into v_batch from public.agh_handoff_batches where id = p_batch_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'batch_not_found', 'error', 'batch not found');
  end if;
  if v_batch.queue_state not in ('AWAITING_GROK_REVIEW', 'GROK_REVIEWED', 'APPROVED_FOR_SEND') then
    return jsonb_build_object('ok', false, 'code', 'batch_not_in_review',
      'error', format('batch is %s; record review needs AWAITING_GROK_REVIEW, GROK_REVIEWED, or APPROVED_FOR_SEND', v_batch.queue_state));
  end if;

  for v_item in select * from jsonb_array_elements(p_decisions)
  loop
    begin
      select * into v_rec from public.agh_handoff_records
       where id = (v_item->>'record_id')::uuid and batch_id = p_batch_id
       for update;
    exception when invalid_text_representation then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('record_id', v_item->>'record_id', 'reason', 'invalid_record_id'));
      continue;
    end;
    if not found then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('record_id', v_item->>'record_id', 'reason', 'not_in_batch'));
      continue;
    end if;
    if v_rec.submitted_at is not null then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('record_id', v_rec.id, 'reason', 'already_submitted'));
      continue;
    end if;

    v_dec := lower(coalesce(v_item->>'decision', ''));
    v_codes := case when jsonb_typeof(v_item->'reason_codes') = 'array' then v_item->'reason_codes' else '[]'::jsonb end;
    v_reason := nullif(trim(coalesce(v_item->>'reason', '')), '');
    v_text := public.agh_compose_rejection_reason(v_codes, v_reason);
    v_hist := jsonb_build_object(
      'decision', v_dec, 'reason_codes', v_codes, 'reason', v_reason,
      'by', p_actor, 'by_label', p_actor_label, 'at', now(),
      'from_state', v_rec.queue_state, 'song_fit', v_item->'song_fit');

    if v_dec = 'reviewed' then
      if v_rec.queue_state <> 'AWAITING_GROK_REVIEW' then
        v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('record_id', v_rec.id, 'reason', 'not_awaiting_review', 'queue_state', v_rec.queue_state));
        continue;
      end if;
      update public.agh_handoff_records
         set queue_state = 'GROK_REVIEWED',
             reviewed_by = coalesce(reviewed_by, p_actor),
             reviewed_by_label = coalesce(reviewed_by_label, p_actor_label),
             packet = (packet - 'review_defer') || jsonb_build_object('review_history',
               coalesce(packet->'review_history', '[]'::jsonb) || jsonb_build_array(v_hist)),
             updated_at = now()
       where id = v_rec.id;
    elsif v_dec = 'approve' then
      v_policy := public.agh_record_can_approve(v_rec.id);
      if coalesce(p_actor,'') not in ('fendi','grok_playlist_control') or v_item->>'verdict' is distinct from 'PASS'
         or v_reason is null or not coalesce((v_policy->>'ok')::boolean,false) then
        v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
          'record_id', v_rec.id,
          'reason', coalesce(v_policy->>'code', 'pass_review_required'),
          'code', v_policy->>'code',
          'pitch_log_id', v_policy->>'pitch_log_id',
          'cooldown_until', v_policy->>'cooldown_until'));
        continue;
      end if;
      update public.agh_handoff_records set queue_state='APPROVED_FOR_SEND',approved_by=p_actor,approved_by_label=p_actor_label,
        reviewed_by = coalesce(reviewed_by, p_actor), reviewed_by_label = coalesce(reviewed_by_label, p_actor_label),
        packet=packet||jsonb_build_object('grok_review',jsonb_build_object('verdict','PASS','reason',v_reason,'actor',p_actor,'at',now()),
        'review_history',coalesce(packet->'review_history','[]'::jsonb)||jsonb_build_array(v_hist)),updated_at=now()
      where id=v_rec.id;
    elsif v_dec = 'reject' then
      if v_rec.queue_state not in ('AWAITING_GROK_REVIEW', 'GROK_REVIEWED', 'APPROVED_FOR_SEND') then
        v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('record_id', v_rec.id, 'reason', 'not_in_review', 'queue_state', v_rec.queue_state));
        continue;
      end if;
      if v_text is null then
        v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('record_id', v_rec.id, 'reason', 'reason_required'));
        continue;
      end if;
      update public.agh_handoff_records
         set queue_state = 'REJECTED_BY_GROK',
             reviewed_by = coalesce(reviewed_by, p_actor),
             reviewed_by_label = coalesce(reviewed_by_label, p_actor_label),
             rejected_by = p_actor,
             rejected_by_label = p_actor_label,
             rejection_reason = v_text,
             packet = packet || jsonb_build_object(
               'rejection', jsonb_build_object('reason_codes', v_codes, 'reason', v_reason, 'by', p_actor, 'at', now()),
               'review_history', coalesce(packet->'review_history', '[]'::jsonb) || jsonb_build_array(v_hist)),
             updated_at = now()
       where id = v_rec.id;
    elsif v_dec = 'defer' then
      if v_rec.queue_state <> 'AWAITING_GROK_REVIEW' then
        v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('record_id', v_rec.id, 'reason', 'not_awaiting_review', 'queue_state', v_rec.queue_state));
        continue;
      end if;
      update public.agh_handoff_records
         set packet = packet || jsonb_build_object(
               'review_defer', jsonb_build_object('reason_codes', v_codes, 'reason', v_reason,
                 'retry_after', v_item->>'retry_after', 'by', p_actor, 'at', now()),
               'review_history', coalesce(packet->'review_history', '[]'::jsonb) || jsonb_build_array(v_hist)),
             updated_at = now()
       where id = v_rec.id;
    else
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('record_id', v_rec.id, 'reason', 'unknown_decision'));
      continue;
    end if;
    v_applied := v_applied || jsonb_build_array(jsonb_build_object('record_id', v_rec.id, 'decision', v_dec, 'from_state', v_rec.queue_state));
  end loop;

  perform public.agh_rollup_decided_handoff_batch(p_batch_id, p_actor, p_actor_label, true);

  select coalesce(jsonb_object_agg(queue_state, n), '{}'::jsonb) into v_counts
    from (select queue_state, count(*) as n from public.agh_handoff_records where batch_id = p_batch_id group by 1) s;

  return jsonb_build_object(
    'ok', true,
    'batch_id', p_batch_id,
    'batch_queue_state', (select queue_state from public.agh_handoff_batches where id = p_batch_id),
    'record_counts', v_counts,
    'applied', v_applied,
    'applied_count', jsonb_array_length(v_applied),
    'skipped', v_skipped);
end;
$$;

-- Records gained SENT in 20261004230000. Batches did not, so a rollup target of
-- SENT would violate agh_handoff_batches.queue_state. Idempotent on both tables.
do $$
declare
  c record;
  allows_sent boolean := false;
begin
  for c in
    select conname, pg_get_constraintdef(oid) as def
    from pg_constraint
    where conrelid = 'public.agh_handoff_batches'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%queue_state%'
      and pg_get_constraintdef(oid) ilike '%APPROVED_FOR_SEND%'
  loop
    if c.def ilike '%''SENT''%' then
      allows_sent := true;
    else
      execute format('alter table public.agh_handoff_batches drop constraint %I', c.conname);
    end if;
  end loop;
  if not allows_sent then
    alter table public.agh_handoff_batches
      add constraint agh_handoff_batches_queue_state_check
      check (queue_state in (
        'CLAUDE_BATCH_READY',
        'CLAUDE_PLAYLIST_COMPLETE',
        'AWAITING_GROK_REVIEW',
        'GROK_REVIEWED',
        'APPROVED_FOR_SEND',
        'REJECTED_BY_GROK',
        'AWAITING_AGH_IMPORT',
        'IMPORTED_TO_AGH',
        'SENT'
      ));
  end if;

  allows_sent := false;
  for c in
    select conname, pg_get_constraintdef(oid) as def
    from pg_constraint
    where conrelid = 'public.agh_handoff_records'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%queue_state%'
      and pg_get_constraintdef(oid) ilike '%APPROVED_FOR_SEND%'
  loop
    if c.def ilike '%''SENT''%' then
      allows_sent := true;
    else
      execute format('alter table public.agh_handoff_records drop constraint %I', c.conname);
    end if;
  end loop;
  if not allows_sent then
    alter table public.agh_handoff_records
      add constraint agh_handoff_records_queue_state_check
      check (queue_state in (
        'CLAUDE_BATCH_READY',
        'CLAUDE_PLAYLIST_COMPLETE',
        'AWAITING_GROK_REVIEW',
        'GROK_REVIEWED',
        'APPROVED_FOR_SEND',
        'REJECTED_BY_GROK',
        'AWAITING_AGH_IMPORT',
        'IMPORTED_TO_AGH',
        'SENT'
      ));
  end if;
end $$;

-- One-time backfill. Idempotent. Does not change record decisions.
do $$
declare r record;
begin
  for r in
    select id from public.agh_handoff_batches
     where batch_kind = 'playlist'
       and queue_state in ('AWAITING_GROK_REVIEW', 'GROK_REVIEWED')
  loop
    perform public.agh_rollup_decided_handoff_batch(r.id, null, null, true);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Promote CLAUDE_BATCH_READY / CLAUDE_PLAYLIST_COMPLETE with no date filter.
--    Null business_date_ct is included. A route that fails agh_route_failure_code,
--    still carries route_hold, or was last verified more than 7 days ago goes to
--    re-verification (agh_route_hold_records) and is not promoted.
-- ---------------------------------------------------------------------------
create or replace function public.agh_promote_claude_ready_batches(
  p_dry_run boolean default true,
  p_business_date date default null,
  p_batch_ids uuid[] default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch public.agh_handoff_batches%rowtype;
  v_rec public.agh_handoff_records%rowtype;
  v_target public.playlist_targets%rowtype;
  v_fail text;
  v_stale boolean;
  v_fresh uuid[];
  v_stale_ids uuid[];
  v_items jsonb;
  v_hold jsonb;
  v_advance jsonb;
  v_dest uuid;
  v_state text;
  v_batches jsonb := '[]'::jsonb;
  v_promote_records int := 0;
  v_reverify_records int := 0;
  v_promoted_batches int := 0;
  v_stamps jsonb;
begin
  for v_batch in
    select * from public.agh_handoff_batches b
     where b.batch_kind = 'playlist'
       and b.queue_state in ('CLAUDE_BATCH_READY', 'CLAUDE_PLAYLIST_COMPLETE')
       and (p_batch_ids is null or b.id = any(p_batch_ids))
       and (
         p_business_date is null
         or b.business_date_ct is null
         or b.business_date_ct = p_business_date
       )
     order by b.created_at
  loop
    v_fresh := '{}'::uuid[];
    v_stale_ids := '{}'::uuid[];
    for v_rec in
      select * from public.agh_handoff_records
       where batch_id = v_batch.id
         and submitted_at is null
         and queue_state in ('CLAUDE_BATCH_READY', 'CLAUDE_PLAYLIST_COMPLETE')
    loop
      select * into v_target from public.playlist_targets where playlist_id = v_rec.playlist_target_id;
      if not found then
        v_stale := true;
        v_fail := 'target_missing';
      else
        v_fail := public.agh_route_failure_code(
          v_rec.submission_channel,
          v_target.verification_status,
          v_target.path_verified,
          v_target.curator_email,
          v_target.form_url,
          v_target.submission_url,
          v_target.form_source_evidence,
          coalesce(v_target.ig_curator_account, v_target.curator_instagram),
          v_target.ig_source_evidence,
          null,
          v_target.is_active);
        v_stale := v_rec.packet ? 'route_hold'
          or v_fail is not null
          or v_target.last_verified_at is null
          or v_target.last_verified_at < now() - interval '7 days';
      end if;
      if v_stale then
        v_stale_ids := v_stale_ids || v_rec.id;
      else
        v_fresh := v_fresh || v_rec.id;
      end if;
    end loop;

    v_promote_records := v_promote_records + coalesce(array_length(v_fresh, 1), 0);
    v_reverify_records := v_reverify_records + coalesce(array_length(v_stale_ids, 1), 0);
    v_batches := v_batches || jsonb_build_array(jsonb_build_object(
      'batch_id', v_batch.id,
      'business_date_ct', v_batch.business_date_ct,
      'null_business_date', v_batch.business_date_ct is null,
      'from_status', v_batch.queue_state,
      'route_hold_repair', coalesce(v_batch.payload->>'route_hold_repair', 'false') = 'true',
      'would_promote', coalesce(array_length(v_fresh, 1), 0),
      'reverify', coalesce(array_length(v_stale_ids, 1), 0),
      'action', case
        when coalesce(array_length(v_fresh, 1), 0) = 0 then 'reverify_only'
        when coalesce(array_length(v_stale_ids, 1), 0) > 0 then 'split_promote'
        else 'promote'
      end
    ));

    if p_dry_run then
      continue;
    end if;

    if exists (
      select 1 from public.agh_handoff_records
       where batch_id = v_batch.id
         and submitted_at is null
         and queue_state not in ('CLAUDE_BATCH_READY', 'CLAUDE_PLAYLIST_COMPLETE', 'REJECTED_BY_GROK')
    ) then
      continue;
    end if;

    v_items := (
      select coalesce(jsonb_agg(jsonb_build_object(
        'record_id', id,
        'code', 'stale_route',
        'reason', 'Route failed current verification or is older than 7 days; held for re-verification instead of promotion'
      )), '[]'::jsonb)
      from public.agh_handoff_records
      where id = any(v_stale_ids)
    );

    if coalesce(array_length(v_fresh, 1), 0) = 0 then
      if coalesce(v_batch.payload->>'route_hold_repair', 'false') <> 'true' and v_items <> '[]'::jsonb then
        v_hold := public.agh_route_hold_records(v_items, 'claude_ready_promotion');
        if coalesce((v_hold->>'ok')::boolean, false) is not true then
          raise exception 'route hold failed for batch %: %', v_batch.id, v_hold;
        end if;
      end if;
      continue;
    end if;

    v_dest := v_batch.id;
    if coalesce(array_length(v_stale_ids, 1), 0) > 0
       and coalesce(v_batch.payload->>'route_hold_repair', 'false') = 'true' then
      insert into public.agh_handoff_batches (
        batch_kind, queue_state, track_id, song_dna_version_id,
        discovered_by, discovered_by_label, drafted_by, drafted_by_label,
        business_date_ct, notes, payload, record_count
      ) values (
        v_batch.batch_kind, 'CLAUDE_BATCH_READY', v_batch.track_id, v_batch.song_dna_version_id,
        v_batch.discovered_by, v_batch.discovered_by_label, v_batch.drafted_by, v_batch.drafted_by_label,
        v_batch.business_date_ct,
        format('Fresh routes split from repair batch %s for Grok review. Stale routes stayed on re-verification.', v_batch.id),
        jsonb_build_object('promotion_split_from', v_batch.id, 'route_hold_repair', false),
        0
      ) returning id into v_dest;
      update public.agh_handoff_records
         set batch_id = v_dest, updated_at = now()
       where id = any(v_fresh);
    elsif v_items <> '[]'::jsonb then
      v_hold := public.agh_route_hold_records(v_items, 'claude_ready_promotion');
      if coalesce((v_hold->>'ok')::boolean, false) is not true then
        raise exception 'route hold failed for batch %: %', v_batch.id, v_hold;
      end if;
    end if;

    v_stamps := jsonb_build_object(
      'drafted_by', (select drafted_by from public.agh_handoff_batches where id = v_dest),
      'drafted_by_label', (select drafted_by_label from public.agh_handoff_batches where id = v_dest)
    );
    select queue_state into v_state from public.agh_handoff_batches where id = v_dest;

    if v_state = 'CLAUDE_BATCH_READY' then
      v_advance := public.advance_agh_handoff_batch(v_dest, 'CLAUDE_BATCH_READY', 'CLAUDE_PLAYLIST_COMPLETE', v_stamps);
      if coalesce((v_advance->>'ok')::boolean, false) is not true then
        raise exception 'promote step failed for %: %', v_dest, v_advance;
      end if;
      v_state := 'CLAUDE_PLAYLIST_COMPLETE';
    end if;
    if v_state = 'CLAUDE_PLAYLIST_COMPLETE' then
      v_advance := public.advance_agh_handoff_batch(v_dest, 'CLAUDE_PLAYLIST_COMPLETE', 'AWAITING_GROK_REVIEW', v_stamps);
      if coalesce((v_advance->>'ok')::boolean, false) is not true then
        raise exception 'promote step failed for %: %', v_dest, v_advance;
      end if;
    end if;
    v_promoted_batches := v_promoted_batches + 1;

    update public.agh_handoff_batches b
       set record_count = (select count(*) from public.agh_handoff_records r where r.batch_id = b.id),
           updated_at = now()
     where b.id in (v_batch.id, v_dest);
  end loop;

  return jsonb_build_object(
    'ok', true,
    'dry_run', p_dry_run,
    'date_filter', p_business_date,
    'includes_null_business_date', true,
    'batches_seen', jsonb_array_length(v_batches),
    'would_promote_records', v_promote_records,
    'reverify_records', v_reverify_records,
    'promoted_batches', case when p_dry_run then 0 else v_promoted_batches end,
    'batches', v_batches,
    'note', 'Stale routes are re-verified, not promoted. Promotion stops at AWAITING_GROK_REVIEW.'
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Pending review older than 7 days returns to route re-verification.
-- ---------------------------------------------------------------------------
create or replace function public.agh_age_pending_handoff_records(
  p_dry_run boolean default true,
  p_max_age interval default interval '7 days'
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_items jsonb;
  v_ids jsonb;
  v_batches jsonb;
  v_hold jsonb;
  v_count int;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
           'record_id', r.id,
           'code', 'pending_review_aged',
           'reason', 'Pending review longer than 7 days; returned for route re-verification'
         ) order by r.created_at), '[]'::jsonb),
         coalesce(jsonb_agg(r.id order by r.created_at), '[]'::jsonb),
         coalesce(jsonb_agg(distinct r.batch_id), '[]'::jsonb),
         count(*)
    into v_items, v_ids, v_batches, v_count
    from public.agh_handoff_records r
    join public.agh_handoff_batches b on b.id = r.batch_id
   where b.batch_kind = 'playlist'
     and r.queue_state = 'AWAITING_GROK_REVIEW'
     and r.submitted_at is null
     and r.created_at < now() - p_max_age;

  if not p_dry_run and v_items <> '[]'::jsonb then
    v_hold := public.agh_route_hold_records(v_items, 'pending_review_age');
    if coalesce((v_hold->>'ok')::boolean, false) is not true then
      return jsonb_build_object('ok', false, 'dry_run', false, 'error', v_hold, 'pending_records', v_count);
    end if;
  end if;

  return jsonb_build_object(
    'ok', true,
    'dry_run', p_dry_run,
    'max_age', p_max_age,
    'pending_records', v_count,
    'record_ids', v_ids,
    'batch_ids', v_batches,
    'held', case when p_dry_run then '[]'::jsonb else coalesce(v_hold->'held', '[]'::jsonb) end,
    'note', 'Aged records go to a CLAUDE_BATCH_READY repair batch. They are not rejected and not approved.'
  );
end;
$$;

create or replace function public.agh_handoff_backlog_maintenance(
  p_dry_run boolean default true
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_rollup jsonb := '[]'::jsonb;
  v_row jsonb;
begin
  for r in
    select id from public.agh_handoff_batches
     where batch_kind = 'playlist'
       and queue_state in ('AWAITING_GROK_REVIEW', 'GROK_REVIEWED')
  loop
    v_row := public.agh_rollup_decided_handoff_batch(r.id, null, null, not p_dry_run);
    if coalesce((v_row->>'to_status'), '') <> '' and (v_row->>'from_status') is distinct from (v_row->>'to_status') then
      v_rollup := v_rollup || jsonb_build_array(v_row);
    end if;
  end loop;

  return jsonb_build_object(
    'ok', true,
    'dry_run', p_dry_run,
    'rollup', v_rollup,
    'aging', public.agh_age_pending_handoff_records(p_dry_run, interval '7 days'),
    'promotion', public.agh_promote_claude_ready_batches(p_dry_run, null, null)
  );
end;
$$;

do $$
declare r record;
begin
  for r in
    select oid::regprocedure as signature
      from pg_proc
     where pronamespace = 'public'::regnamespace
       and proname in (
         'agh_decided_handoff_rollup_target',
         'agh_rollup_decided_handoff_batch',
         'agh_review_handoff_records',
         'agh_promote_claude_ready_batches',
         'agh_age_pending_handoff_records',
         'agh_handoff_backlog_maintenance'
       )
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.signature);
    execute format('grant execute on function %s to service_role', r.signature);
  end loop;
end $$;

-- Hourly sweep. Skipped where pg_cron is not installed (local migration tests).
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if exists (select 1 from cron.job where jobname = 'agh-handoff-backlog-maintenance') then
      perform cron.unschedule('agh-handoff-backlog-maintenance');
    end if;
    perform cron.schedule(
      'agh-handoff-backlog-maintenance',
      '15 * * * *',
      'select public.agh_handoff_backlog_maintenance(false)'
    );
  end if;
end $$;

notify pgrst, 'reload schema';
commit;
