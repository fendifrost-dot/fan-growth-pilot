-- Live database state, 2026-11-18. Already applied. This migration records it
-- so supabase/migrations matches the functions that are running.
--
-- agh_review_handoff_records: record-level review in any batch state. A record
-- outside the review states is staged into a sibling AWAITING_GROK_REVIEW batch
-- (the source batch is not lifted wholesale). An open twin on
-- agh_handoff_records_open_pair_uidx is skipped as duplicate_open_record instead
-- of failing the move. Kept: generated_by='fendi' protection, route_hold,
-- Soundplate freeze, dedupe/cooldown via agh_record_can_approve, and
-- paid_for_fendi (stamp only — never send, submit, or pay).
--
-- An earlier statement of this function from the same day (record-level review
-- and sibling staging, without the twin skip) is not in supabase/migrations/.
-- The live body below is that statement plus the duplicate_open_record skip, so
-- it is installed once.
--
-- agh_positive_submission_fee: a paid-platform host does not count when
-- submission_cost and form_cost are both 'free' (a live check confirmed the
-- form is free). Other paid signals are unchanged.

begin;

CREATE OR REPLACE FUNCTION public.agh_review_handoff_records(p_batch_id uuid, p_decisions jsonb, p_actor text, p_actor_label text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  v_stage uuid;
  v_staged jsonb := '[]'::jsonb;
  v_frozen boolean;
  v_orig public.agh_handoff_records%rowtype;
  v_was_staged boolean;
  v_twin uuid;
  v_twin_state text;
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
  -- Record-level review works in any batch state (Fendi, 2026-11-18: no gate he did not
  -- ask for). A record sitting outside the review states is staged into a sibling
  -- AWAITING_GROK_REVIEW batch first, so the old batch is never lifted wholesale.

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

    -- Never touch records whose draft Fendi wrote himself.
    if exists (select 1 from public.outreach_drafts d where d.id = v_rec.outreach_draft_id and d.generated_by = 'fendi') then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('record_id', v_rec.id, 'reason', 'ATTRIBUTION_GAP', 'code', 'fendi_draft_protected'));
      continue;
    end if;
    -- Frozen / held records stay put (Soundplate freeze, genuine route holds).
    if v_rec.packet ? 'route_hold' then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('record_id', v_rec.id, 'reason', 'record_held', 'code', 'record_held'));
      continue;
    end if;

    v_dec := lower(coalesce(v_item->>'decision', ''));
    v_frozen := exists (select 1 from public.playlist_targets t where t.playlist_id = v_rec.playlist_target_id and t::text ilike '%soundplate%');
    if v_frozen and v_dec in ('reviewed', 'approve') then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('record_id', v_rec.id, 'reason', 'soundplate_frozen', 'code', 'soundplate_frozen'));
      continue;
    end if;
    if v_dec = 'reject' and v_rec.queue_state = 'REJECTED_BY_GROK' then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('record_id', v_rec.id, 'reason', 'already_rejected', 'queue_state', v_rec.queue_state));
      continue;
    end if;

    v_was_staged := false;
    v_twin := null; v_twin_state := null;
    -- Stage records that sit outside the review states into a sibling review batch.
    if v_dec in ('reviewed', 'approve', 'defer')
       and v_rec.queue_state in ('CLAUDE_BATCH_READY', 'CLAUDE_PLAYLIST_COMPLETE', 'REJECTED_BY_GROK') then
      -- An open twin (same track, target, channel, DNA) already exists: the unique index
      -- would reject the move. Point at the twin instead of failing.
      select o.id, o.queue_state into v_twin, v_twin_state from public.agh_handoff_records o
       where o.id <> v_rec.id and o.track_id = v_rec.track_id and o.playlist_target_id = v_rec.playlist_target_id
         and o.submission_channel = v_rec.submission_channel and o.song_dna_version_id = v_rec.song_dna_version_id
         and o.queue_state not in ('REJECTED_BY_GROK', 'IMPORTED_TO_AGH') limit 1;
      if v_twin is not null and v_rec.queue_state = 'REJECTED_BY_GROK' then
        v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('record_id', v_rec.id, 'reason', 'duplicate_open_record',
          'code', 'duplicate_open_record', 'twin_record_id', v_twin, 'twin_queue_state', v_twin_state));
        continue;
      end if;
      if v_stage is null then
        select id into v_stage from public.agh_handoff_batches
         where payload->>'record_review_source_batch' = p_batch_id::text
           and queue_state = 'AWAITING_GROK_REVIEW'
         order by created_at limit 1;
        if v_stage is null then
          insert into public.agh_handoff_batches (
            batch_kind, queue_state, track_id, song_dna_version_id,
            discovered_by, discovered_by_label, drafted_by, drafted_by_label,
            business_date_ct, notes, payload, record_count
          ) values (
            v_batch.batch_kind, 'AWAITING_GROK_REVIEW', v_batch.track_id, v_batch.song_dna_version_id,
            v_batch.discovered_by, v_batch.discovered_by_label, v_batch.drafted_by, v_batch.drafted_by_label,
            v_batch.business_date_ct,
            format('Record-level review staging from batch %s (was %s).', v_batch.id, v_batch.queue_state),
            jsonb_build_object('record_review_source_batch', v_batch.id, 'source_queue_state', v_batch.queue_state),
            0
          ) returning id into v_stage;
        end if;
      end if;
      v_orig := v_rec;
      v_was_staged := true;
      update public.agh_handoff_records
         set batch_id = v_stage,
             queue_state = 'AWAITING_GROK_REVIEW',
             rejected_by = null, rejected_by_label = null, rejection_reason = null,
             packet = case when v_rec.queue_state = 'REJECTED_BY_GROK'
               then (packet - 'rejection') || jsonb_build_object('rejection_prior', packet->'rejection')
               else packet end,
             updated_at = now()
       where id = v_rec.id;
      v_staged := v_staged || jsonb_build_array(jsonb_build_object('record_id', v_rec.id, 'from_state', v_rec.queue_state));
      select * into v_rec from public.agh_handoff_records where id = v_rec.id;
    end if;

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
        -- A refused approval leaves the record exactly where it was.
        if v_was_staged then
          update public.agh_handoff_records
             set batch_id = v_orig.batch_id, queue_state = v_orig.queue_state,
                 rejected_by = v_orig.rejected_by, rejected_by_label = v_orig.rejected_by_label,
                 rejection_reason = v_orig.rejection_reason, packet = v_orig.packet, updated_at = v_orig.updated_at
           where id = v_rec.id;
          select * into v_rec from public.agh_handoff_records where id = v_rec.id;
          v_staged := (select coalesce(jsonb_agg(e), '[]'::jsonb) from jsonb_array_elements(v_staged) e where e->>'record_id' <> v_rec.id::text);
        end if;
        -- Paid targets are not failed: they are held for Fendi's yes/no and never
        -- approved, sent or paid automatically (2026-11-18).
        if v_policy->>'code' = 'paid_for_fendi' and not (v_rec.packet ? 'paid_for_fendi') then
          update public.agh_handoff_records
             set packet = packet || jsonb_build_object('paid_for_fendi', jsonb_build_object(
                   'at', now(), 'by', p_actor, 'reason', v_reason,
                   'status', 'awaiting_fendi_decision'),
                   'review_history', coalesce(packet->'review_history', '[]'::jsonb) || jsonb_build_array(v_hist)),
                 updated_at = now()
           where id = v_rec.id;
        end if;
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
      if v_rec.queue_state in ('SENT', 'AWAITING_AGH_IMPORT', 'IMPORTED_TO_AGH') then
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
  if v_stage is not null and not exists (select 1 from public.agh_handoff_records where batch_id = v_stage) then
    delete from public.agh_handoff_batches where id = v_stage;
    v_stage := null;
  end if;
  if v_stage is not null then
    update public.agh_handoff_batches b
       set record_count = (select count(*) from public.agh_handoff_records r where r.batch_id = b.id), updated_at = now()
     where b.id in (p_batch_id, v_stage);
    perform public.agh_rollup_decided_handoff_batch(v_stage, p_actor, p_actor_label, true);
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
    'staged_batch_id', v_stage,
    'staged', v_staged,
    'skipped', v_skipped);
end;
$function$;

create or replace function public.agh_positive_submission_fee(p_submission_cost text, p_form_cost text, p_submission_method text, p_pitch_status text, p_fraud_verdict text, p_form_url text, p_submission_url text, p_website text, p_email text, p_evidence text)
 returns boolean
 language sql
 immutable
 set search_path to 'public'
as $function$
  select
    lower(trim(coalesce(p_submission_cost, ''))) not in ('', 'free', 'unknown')
    or lower(trim(coalesce(p_form_cost, ''))) in ('paid', 'tip_appreciated')
    or (
      lower(trim(coalesce(p_form_cost, ''))) not in ('', 'free', 'unknown')
      and lower(trim(coalesce(p_form_cost, ''))) ~ '[$€£]|[0-9]'
    )
    or lower(trim(coalesce(p_pitch_status, ''))) = 'pay_to_play'
    or lower(trim(coalesce(p_fraud_verdict, ''))) = 'pay_to_play'
    or lower(trim(coalesce(p_submission_method, ''))) in (
      'submithub', 'groover', 'playlistpush', 'playlist_push', 'submitlink'
    )
    -- A paid-platform host only counts when the route is not explicitly confirmed free
    -- (both submission_cost and form_cost set to 'free' after a live check of the form).
    or (
      not (
        lower(trim(coalesce(p_submission_cost, ''))) = 'free'
        and lower(trim(coalesce(p_form_cost, ''))) = 'free'
      )
      and (
        public.agh_host_is_paid_platform(public.agh_url_host(p_form_url))
        or public.agh_host_is_paid_platform(public.agh_url_host(p_submission_url))
        or public.agh_host_is_paid_platform(public.agh_url_host(p_website))
        or public.agh_host_is_paid_platform(public.agh_url_host(p_email))
      )
    )
    or public.agh_evidence_has_paid_signal(p_evidence);
$function$;

commit;
