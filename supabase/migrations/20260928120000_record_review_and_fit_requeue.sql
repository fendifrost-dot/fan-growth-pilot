-- ---------------------------------------------------------------------------
-- 2026-09-28: record-level review truth + one song-fit authority.
--
--   1. agh_playlist_candidate_evaluations.outcome gains 'deferred' (cooldown / temporary
--      host or DB failure — retry later, not a rejection).
--   2. advance_agh_handoff_batch no longer sweeps records Grok rejected individually,
--      and copies a batch-level rejection reason onto the records it rejects.
--   3. agh_review_handoff_records — Grok record-level decisions (reviewed / reject /
--      defer); the batch state is derived from its records afterwards.
--   4. agh_handoff_state_audit — read-only: mixed batches, record counts by song/state,
--      distinct rejected records vs reason occurrences, fit-based rejections.
--   5. agh_fit_rejection_requeue(p_apply) — preview/apply: records rejected for a
--      DNA/lane mismatch that the song's current approved DNA actually allows, and that
--      pass route + contact checks, go back to AWAITING_GROK_REVIEW in a requeue batch
--      with their rejection history kept. Never approves or sends.
--
-- Depends on 20260927120000_route_hold_and_candidate_log.sql (agh_route_failure_code).
-- Idempotent: create or replace / guarded alters. Wrapped in one transaction.
-- ---------------------------------------------------------------------------
begin;

-- 1. 'deferred' candidate outcome --------------------------------------------
do $$
begin
  if to_regclass('public.agh_playlist_candidate_evaluations') is not null then
    alter table public.agh_playlist_candidate_evaluations
      drop constraint if exists agh_playlist_candidate_evaluations_outcome_check;
    alter table public.agh_playlist_candidate_evaluations
      add constraint agh_playlist_candidate_evaluations_outcome_check
      check (outcome in (
        'verified_eligible_new', 'verified_eligible_existing', 'accepted_unverified',
        'duplicate', 'rejected', 'deferred'
      ));
  end if;
end $$;

-- 2. advance RPC: preserve record-level rejections -----------------------------
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
  v_legal boolean := false;
  v_stamps jsonb := coalesce(p_stamps, '{}'::jsonb);
begin
  if p_batch_id is null or p_expected_state is null or p_next_state is null then
    return jsonb_build_object('ok', false, 'code', 'bad_request', 'error', 'batch_id and states required');
  end if;

  if p_expected_state = 'CLAUDE_BATCH_READY' and p_next_state = 'CLAUDE_PLAYLIST_COMPLETE' then
    v_legal := true;
  elsif p_expected_state = 'CLAUDE_PLAYLIST_COMPLETE' and p_next_state = 'AWAITING_GROK_REVIEW' then
    v_legal := true;
  elsif p_expected_state = 'AWAITING_GROK_REVIEW' and p_next_state = 'GROK_REVIEWED' then
    v_legal := true;
  elsif p_expected_state = 'GROK_REVIEWED' and p_next_state in ('APPROVED_FOR_SEND', 'REJECTED_BY_GROK') then
    v_legal := true;
  elsif p_expected_state = 'APPROVED_FOR_SEND' and p_next_state = 'AWAITING_AGH_IMPORT' then
    v_legal := true;
  elsif p_expected_state = 'AWAITING_AGH_IMPORT' and p_next_state = 'IMPORTED_TO_AGH' then
    v_legal := true;
  end if;

  if not v_legal then
    return jsonb_build_object(
      'ok', false,
      'code', 'illegal_transition',
      'error', format('Illegal handoff transition %s → %s', p_expected_state, p_next_state),
      'expected', p_expected_state,
      'attempted', p_next_state
    );
  end if;

  update public.agh_handoff_batches b
     set queue_state = p_next_state,
         updated_at = now(),
         drafted_by = case
           when p_next_state in ('CLAUDE_PLAYLIST_COMPLETE', 'AWAITING_GROK_REVIEW')
             then coalesce(b.drafted_by, nullif(v_stamps->>'drafted_by', ''))
           else b.drafted_by
         end,
         drafted_by_label = case
           when p_next_state in ('CLAUDE_PLAYLIST_COMPLETE', 'AWAITING_GROK_REVIEW')
             then coalesce(b.drafted_by_label, nullif(v_stamps->>'drafted_by_label', ''))
           else b.drafted_by_label
         end,
         reviewed_by = case
           when p_next_state = 'GROK_REVIEWED'
             then coalesce(b.reviewed_by, nullif(v_stamps->>'reviewed_by', ''))
           else b.reviewed_by
         end,
         reviewed_by_label = case
           when p_next_state = 'GROK_REVIEWED'
             then coalesce(b.reviewed_by_label, nullif(v_stamps->>'reviewed_by_label', ''))
           else b.reviewed_by_label
         end,
         approved_by = case
           when p_next_state = 'APPROVED_FOR_SEND'
             then coalesce(b.approved_by, nullif(v_stamps->>'approved_by', ''))
           else b.approved_by
         end,
         approved_by_label = case
           when p_next_state = 'APPROVED_FOR_SEND'
             then coalesce(b.approved_by_label, nullif(v_stamps->>'approved_by_label', ''))
           else b.approved_by_label
         end,
         rejected_by = case
           when p_next_state = 'REJECTED_BY_GROK'
             then coalesce(b.rejected_by, nullif(v_stamps->>'rejected_by', ''))
           else b.rejected_by
         end,
         rejected_by_label = case
           when p_next_state = 'REJECTED_BY_GROK'
             then coalesce(b.rejected_by_label, nullif(v_stamps->>'rejected_by_label', ''))
           else b.rejected_by_label
         end,
         notes = case
           when p_next_state = 'REJECTED_BY_GROK' and nullif(v_stamps->>'notes', '') is not null
             then coalesce(b.notes, v_stamps->>'notes')
           else b.notes
         end
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
         drafted_by = case
           when p_next_state in ('CLAUDE_PLAYLIST_COMPLETE', 'AWAITING_GROK_REVIEW')
             then coalesce(r.drafted_by, nullif(v_stamps->>'drafted_by', ''), v_batch.drafted_by)
           else r.drafted_by
         end,
         drafted_by_label = case
           when p_next_state in ('CLAUDE_PLAYLIST_COMPLETE', 'AWAITING_GROK_REVIEW')
             then coalesce(r.drafted_by_label, nullif(v_stamps->>'drafted_by_label', ''), v_batch.drafted_by_label)
           else r.drafted_by_label
         end,
         reviewed_by = case
           when p_next_state = 'GROK_REVIEWED'
             then coalesce(r.reviewed_by, nullif(v_stamps->>'reviewed_by', ''))
           else r.reviewed_by
         end,
         reviewed_by_label = case
           when p_next_state = 'GROK_REVIEWED'
             then coalesce(r.reviewed_by_label, nullif(v_stamps->>'reviewed_by_label', ''))
           else r.reviewed_by_label
         end,
         approved_by = case
           when p_next_state = 'APPROVED_FOR_SEND'
             then coalesce(r.approved_by, nullif(v_stamps->>'approved_by', ''))
           else r.approved_by
         end,
         approved_by_label = case
           when p_next_state = 'APPROVED_FOR_SEND'
             then coalesce(r.approved_by_label, nullif(v_stamps->>'approved_by_label', ''))
           else r.approved_by_label
         end,
         rejected_by = case
           when p_next_state = 'REJECTED_BY_GROK'
             then coalesce(r.rejected_by, nullif(v_stamps->>'rejected_by', ''))
           else r.rejected_by
         end,
         rejected_by_label = case
           when p_next_state = 'REJECTED_BY_GROK'
             then coalesce(r.rejected_by_label, nullif(v_stamps->>'rejected_by_label', ''))
           else r.rejected_by_label
         end,
         -- Batch-level rejection reason is copied onto each record it rejects.
         rejection_reason = case
           when p_next_state = 'REJECTED_BY_GROK'
             then coalesce(r.rejection_reason, nullif(v_stamps->>'notes', ''))
           else r.rejection_reason
         end
   where r.batch_id = p_batch_id
     -- Record state is authoritative: a record Grok already rejected individually is
     -- never swept forward (or re-stamped) by a later batch-level transition.
     and r.queue_state <> 'REJECTED_BY_GROK';

  get diagnostics v_updated = row_count;

  return jsonb_build_object(
    'ok', true,
    'batch', to_jsonb(v_batch),
    'records_updated', v_updated
  );
end;
$$;

revoke all on function public.advance_agh_handoff_batch(uuid, text, text, jsonb) from public;
revoke all on function public.advance_agh_handoff_batch(uuid, text, text, jsonb) from anon;
revoke all on function public.advance_agh_handoff_batch(uuid, text, text, jsonb) from authenticated;
grant execute on function public.advance_agh_handoff_batch(uuid, text, text, jsonb) to service_role;

comment on function public.advance_agh_handoff_batch(uuid, text, text, jsonb) is
  'Atomic CAS handoff advance. Moves the batch and every record not already REJECTED_BY_GROK (record-level rejections are preserved). SECURITY DEFINER; service_role only.';


-- 3. Grok record-level review ---------------------------------------------------
create or replace function public.agh_review_handoff_records(
  p_batch_id uuid,
  p_decisions jsonb,       -- [{record_id, decision: reviewed|reject|defer, reason_codes[], reason, retry_after, song_fit}]
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
  v_total int;
  v_awaiting int;
  v_reviewed int;
  v_rejected int;
  v_counts jsonb;
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
  if v_batch.queue_state not in ('AWAITING_GROK_REVIEW', 'GROK_REVIEWED') then
    return jsonb_build_object('ok', false, 'code', 'batch_not_in_review',
      'error', format('batch is %s; record review needs AWAITING_GROK_REVIEW or GROK_REVIEWED', v_batch.queue_state));
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
    v_text := nullif(concat_ws(': ',
      nullif((select string_agg(value, ', ') from jsonb_array_elements_text(v_codes)), ''),
      v_reason), '');
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
             packet = packet || jsonb_build_object('review_history',
               coalesce(packet->'review_history', '[]'::jsonb) || jsonb_build_array(v_hist)),
             updated_at = now()
       where id = v_rec.id;
    elsif v_dec = 'reject' then
      if v_rec.queue_state not in ('AWAITING_GROK_REVIEW', 'GROK_REVIEWED') then
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

  -- Batch state follows its records and never moves backwards.
  select count(*),
         count(*) filter (where queue_state = 'AWAITING_GROK_REVIEW'),
         count(*) filter (where queue_state = 'GROK_REVIEWED'),
         count(*) filter (where queue_state = 'REJECTED_BY_GROK')
    into v_total, v_awaiting, v_reviewed, v_rejected
    from public.agh_handoff_records where batch_id = p_batch_id;

  if v_total > 0 and v_awaiting = 0 then
    if v_rejected = v_total and v_batch.queue_state in ('AWAITING_GROK_REVIEW', 'GROK_REVIEWED') then
      update public.agh_handoff_batches
         set queue_state = 'REJECTED_BY_GROK',
             reviewed_by = coalesce(reviewed_by, p_actor), reviewed_by_label = coalesce(reviewed_by_label, p_actor_label),
             rejected_by = coalesce(rejected_by, p_actor), rejected_by_label = coalesce(rejected_by_label, p_actor_label),
             notes = coalesce(notes, 'All records rejected at record level (see each record''s rejection_reason).'),
             updated_at = now()
       where id = p_batch_id;
    elsif v_reviewed > 0 and v_batch.queue_state = 'AWAITING_GROK_REVIEW' then
      update public.agh_handoff_batches
         set queue_state = 'GROK_REVIEWED',
             reviewed_by = coalesce(reviewed_by, p_actor), reviewed_by_label = coalesce(reviewed_by_label, p_actor_label),
             updated_at = now()
       where id = p_batch_id;
    end if;
  end if;

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

revoke all on function public.agh_review_handoff_records(uuid, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.agh_review_handoff_records(uuid, jsonb, text, text) to service_role;

-- 4. Read-only state audit --------------------------------------------------------
create or replace function public.agh_handoff_state_audit(p_batch_ids uuid[] default null)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with b as (
    select * from public.agh_handoff_batches
     where batch_kind = 'playlist'
       and (p_batch_ids is null or id = any(p_batch_ids))
  ),
  r as (
    select r.*, b.queue_state as batch_state, b.notes as batch_notes,
           (r.created_at at time zone 'America/Chicago')::date = (now() at time zone 'America/Chicago')::date as created_today
      from public.agh_handoff_records r join b on b.id = r.batch_id
  ),
  per_batch as (
    select b.id, b.track_id, b.queue_state, b.business_date_ct, b.created_at,
           (select coalesce(jsonb_object_agg(queue_state, n), '{}'::jsonb)
              from (select queue_state, count(*) n from r where r.batch_id = b.id group by 1) s) as record_counts,
           (select count(distinct queue_state) from r where r.batch_id = b.id) as n_states,
           (select count(*) from r where r.batch_id = b.id and r.queue_state <> b.queue_state) as n_diff
      from b
  ),
  rej as (
    select r.*, coalesce(r.rejection_reason, r.batch_notes, '') as why,
           case when jsonb_typeof(r.packet->'rejection'->'reason_codes') = 'array'
                     and jsonb_array_length(r.packet->'rejection'->'reason_codes') > 0
                then jsonb_array_length(r.packet->'rejection'->'reason_codes') else 1 end as n_reasons
      from r where r.queue_state = 'REJECTED_BY_GROK'
  )
  select jsonb_build_object(
    'generated_at', now(),
    'business_date_ct_today', (now() at time zone 'America/Chicago')::date,
    'batches_scanned', (select count(*) from b),
    'records_scanned', (select count(*) from r),
    'records_by_track_state', (
      select coalesce(jsonb_agg(x order by x->>'track_id', x->>'queue_state'), '[]'::jsonb) from (
        select jsonb_build_object('track_id', r.track_id, 'title', t.name, 'queue_state', r.queue_state,
                                  'records', count(*), 'created_today', count(*) filter (where r.created_today),
                                  'created_before_today', count(*) filter (where not r.created_today)) x
          from r left join public.tracks t on t.id = r.track_id
         group by r.track_id, t.name, r.queue_state) s),
    'mixed_batches', (
      select coalesce(jsonb_agg(jsonb_build_object('batch_id', id, 'track_id', track_id, 'batch_state', queue_state,
                                                   'business_date_ct', business_date_ct, 'record_counts', record_counts)
                                order by created_at), '[]'::jsonb)
        from per_batch where n_states > 1 or n_diff > 0),
    'requested_batches', (
      select coalesce(jsonb_agg(jsonb_build_object('batch_id', id, 'track_id', track_id, 'batch_state', queue_state,
                                                   'business_date_ct', business_date_ct, 'record_counts', record_counts)
                                order by created_at), '[]'::jsonb)
        from per_batch where p_batch_ids is not null),
    'rejections', jsonb_build_object(
      'distinct_rejected_records', (select count(*) from rej),
      'reason_occurrences', (select coalesce(sum(n_reasons), 0) from rej),
      'records_with_multiple_reason_codes', (select count(*) from rej where n_reasons > 1),
      'records_with_no_stored_reason', (select count(*) from rej where why = ''),
      'fit_based_rejections', (select count(*) from rej where why ~* '(dna[_ -]*lane|lane[_ -]*mismatch|dna[_ -]*mismatch|genre[_ -]*mismatch|lane[_ -]*not[_ -]*(approved|allowed)|hip[_ -]*hop[_ -]*rap +only|wrong[_ -]*lane|off[_ -]*lane)'),
      'top_reasons', (
        select coalesce(jsonb_agg(jsonb_build_object('reason', why, 'records', n) order by n desc), '[]'::jsonb)
          from (select left(why, 160) as why, count(*) n from rej group by 1 order by 2 desc limit 30) s)
    ),
    'note', 'distinct_rejected_records counts records; reason_occurrences counts reason codes (a record can carry several). Record queue_state is authoritative; batch state is a summary.'
  );
$$;

revoke all on function public.agh_handoff_state_audit(uuid[]) from public, anon, authenticated;
grant execute on function public.agh_handoff_state_audit(uuid[]) to service_role;

-- 5. Requeue fit-based rejections the approved DNA contradicts ----------------------
create or replace function public.agh_fit_rejection_requeue(p_apply boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
  v_items jsonb := '[]'::jsonb;
  v_eligible int := 0;
  v_moved int := 0;
  v_new uuid;
  v_src public.agh_handoff_batches%rowtype;
  v_touched uuid[] := '{}';
  v_bid uuid;
  v_skip text;
begin
  for v_row in
    select r.id, r.batch_id, r.track_id, r.playlist_target_id, r.submission_channel, r.song_dna_version_id,
           r.outreach_draft_id, r.rejection_reason, r.rejected_by_label, r.updated_at,
           coalesce(r.rejection_reason, b.notes, '') as why,
           pt.lane, pt.is_active, pt.verification_status, pt.path_verified, pt.curator_email, pt.form_url,
           pt.submission_url, pt.form_source_evidence, pt.ig_curator_account, pt.ig_source_evidence,
           pt.research_context->>'source_url' as source_url, pt.playlist_id as pt_id,
           t.approved_song_dna_version_id as cur_dna,
           d.id as dna_id, d.track_id as dna_track, d.approval_state, d.approved_lanes, d.excluded_lanes, d.primary_genre,
           od.status as draft_status
      from public.agh_handoff_records r
      join public.agh_handoff_batches b on b.id = r.batch_id and b.batch_kind = 'playlist'
      left join public.playlist_targets pt on pt.playlist_id = r.playlist_target_id
      left join public.tracks t on t.id = r.track_id
      left join public.song_dna_versions d on d.id = t.approved_song_dna_version_id
      left join public.outreach_drafts od on od.id = r.outreach_draft_id
     where r.queue_state = 'REJECTED_BY_GROK'
       and r.submitted_at is null
       and coalesce(r.rejection_reason, b.notes, '') ~* '(dna[_ -]*lane|lane[_ -]*mismatch|dna[_ -]*mismatch|genre[_ -]*mismatch|lane[_ -]*not[_ -]*(approved|allowed)|hip[_ -]*hop[_ -]*rap +only|wrong[_ -]*lane|off[_ -]*lane)'
     order by r.batch_id, r.created_at
  loop
    v_skip := null;
    if v_row.pt_id is null then
      v_skip := 'target_missing';
    elsif v_row.dna_id is null or v_row.approval_state <> 'approved' or v_row.dna_track <> v_row.track_id then
      v_skip := 'no_current_approved_dna';
    elsif v_row.song_dna_version_id is distinct from v_row.cur_dna then
      v_skip := 'dna_version_changed_since_draft';
    elsif nullif(trim(coalesce(v_row.lane, '')), '') is null then
      v_skip := 'lane_missing';
    elsif exists (select 1 from unnest(v_row.excluded_lanes) x where lower(x) = lower(v_row.lane)) then
      v_skip := 'lane_excluded_by_dna';
    elsif cardinality(v_row.approved_lanes) > 0
          and not exists (select 1 from unnest(v_row.approved_lanes) x where lower(x) = lower(v_row.lane)) then
      v_skip := 'lane_not_in_approved_dna';
    elsif public.agh_route_failure_code(v_row.submission_channel, v_row.verification_status, v_row.path_verified,
            v_row.curator_email, v_row.form_url, v_row.submission_url, v_row.form_source_evidence,
            v_row.ig_curator_account, v_row.ig_source_evidence, v_row.source_url, v_row.is_active) is not null then
      v_skip := 'route_fails: ' || public.agh_route_failure_code(v_row.submission_channel, v_row.verification_status,
            v_row.path_verified, v_row.curator_email, v_row.form_url, v_row.submission_url, v_row.form_source_evidence,
            v_row.ig_curator_account, v_row.ig_source_evidence, v_row.source_url, v_row.is_active);
    elsif v_row.submission_channel = 'email' and exists (
            select 1 from public.playlist_targets p2
             where lower(p2.curator_email) = lower(v_row.curator_email)
               and (coalesce(p2.bounce_count, 0) > 0 or p2.last_bounced_at is not null
                    or p2.verification_status in ('bounced', 'spam_flagged'))) then
      v_skip := 'curator_email_suppressed';
    elsif v_row.draft_status in ('sent', 'sent_audit_broken') then
      v_skip := 'already_sent';
    elsif v_row.draft_status = 'rejected' then
      v_skip := 'email_draft_rejected_needs_recompose';
    elsif exists (
            select 1 from public.agh_handoff_records o
             where o.track_id = v_row.track_id and o.playlist_target_id = v_row.playlist_target_id
               and o.id <> v_row.id
               and o.queue_state not in ('REJECTED_BY_GROK', 'IMPORTED_TO_AGH')) then
      v_skip := 'pair_already_open_elsewhere';
    end if;

    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'record_id', v_row.id, 'batch_id', v_row.batch_id, 'track_id', v_row.track_id,
      'playlist_target_id', v_row.playlist_target_id, 'lane', v_row.lane,
      'dna_primary_genre', v_row.primary_genre, 'rejection', left(v_row.why, 200),
      'requeue', v_skip is null, 'skip_reason', v_skip));

    if v_skip is not null then continue; end if;
    v_eligible := v_eligible + 1;
    if not p_apply then continue; end if;

    select * into v_src from public.agh_handoff_batches where id = v_row.batch_id;
    select id into v_new from public.agh_handoff_batches
     where payload->>'fit_requeue_source_batch' = v_src.id::text and queue_state = 'AWAITING_GROK_REVIEW'
     limit 1;
    if v_new is null then
      insert into public.agh_handoff_batches (
        batch_kind, queue_state, track_id, song_dna_version_id,
        discovered_by, discovered_by_label, drafted_by, drafted_by_label,
        business_date_ct, notes, payload, record_count
      ) values (
        v_src.batch_kind, 'AWAITING_GROK_REVIEW', v_src.track_id, v_src.song_dna_version_id,
        v_src.discovered_by, v_src.discovered_by_label, v_src.drafted_by, v_src.drafted_by_label,
        v_src.business_date_ct,
        format('FIT REQUEUE — records from batch %s rejected for a DNA/lane mismatch that the song''s approved Song DNA allows (policy song_fit.v1-2026-09-28). Prior rejection kept in packet.review_history.', v_src.id),
        jsonb_build_object('fit_requeue', true, 'fit_requeue_source_batch', v_src.id, 'policy_version', 'song_fit.v1-2026-09-28'),
        0
      ) returning id into v_new;
    end if;

    update public.agh_handoff_records r
       set batch_id = v_new,
           queue_state = 'AWAITING_GROK_REVIEW',
           reviewed_by = null, reviewed_by_label = null,
           rejected_by = null, rejected_by_label = null,
           approved_by = null, approved_by_label = null,
           rejection_reason = null,
           packet = r.packet || jsonb_build_object(
             'review_history', coalesce(r.packet->'review_history', '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
               'decision', 'reject', 'reason', v_row.why, 'by_label', v_row.rejected_by_label,
               'from_batch', v_row.batch_id, 'at', v_row.updated_at, 'recorded_by', 'agh_fit_rejection_requeue')),
             'fit_requeue', jsonb_build_object(
               'requeued_at', now(), 'from_batch', v_row.batch_id, 'policy_version', 'song_fit.v1-2026-09-28',
               'lane', v_row.lane, 'song_dna_version_id', v_row.cur_dna,
               'why', 'prior DNA/lane rejection contradicted the approved Song DNA; route and contact re-checked')),
           updated_at = now()
     where r.id = v_row.id;
    v_moved := v_moved + 1;
    v_touched := v_touched || v_row.batch_id || v_new;
    v_new := null;
  end loop;

  foreach v_bid in array v_touched
  loop
    update public.agh_handoff_batches b
       set record_count = (select count(*) from public.agh_handoff_records r where r.batch_id = b.id),
           updated_at = now()
     where b.id = v_bid;
  end loop;

  return jsonb_build_object(
    'ok', true, 'applied', p_apply,
    'fit_rejections_found', jsonb_array_length(v_items),
    'eligible_for_requeue', v_eligible,
    'requeued', v_moved,
    'records', v_items);
end;
$$;

revoke all on function public.agh_fit_rejection_requeue(boolean) from public, anon, authenticated;
grant execute on function public.agh_fit_rejection_requeue(boolean) to service_role;

commit;
