-- Approved web-form handoffs could not be marked submitted, and a batch that
-- had already moved to APPROVED_FOR_SEND could not be approved or rejected
-- one record at a time. Batch approval stamps approved_by without writing
-- packet.grok_review. The manual-submit trigger required that verdict to be
-- exactly PASS, so those rows raised pass_approval_required.
--
-- A batch-approved row may be submitted when approved_by is Fendi or Grok
-- Playlist Control. A non-PASS verdict still fails. DNA, evidence, contact
-- policy, and the human submitter check stay in place. Receipts still store
-- handoff_record_id. Existing rows are not rewritten.
begin;

create or replace function public.agh_compose_rejection_reason(p_codes jsonb, p_reason text)
returns text
language sql
immutable
set search_path = public
as $$
  select nullif(concat_ws(': ',
    nullif((
      select string_agg(value, ', ')
      from jsonb_array_elements_text(
        case when jsonb_typeof(p_codes) = 'array' then p_codes else '[]'::jsonb end
      )
    ), ''),
    nullif(trim(coalesce(p_reason, '')), '')
  ), '');
$$;

create or replace function public.agh_log_manual_submission() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  e jsonb;
  t playlist_targets%rowtype;
  d song_dna_versions%rowtype;
  v jsonb;
  pl uuid;
  title text;
  verdict text;
begin
  if new.submitted_at is null or old.submitted_at is not null then return new; end if;
  verdict := coalesce(new.packet->'grok_review'->>'verdict', '');
  if new.manual_submit_channel not in ('web_form', 'instagram_dm')
     or (new.submission_channel is not null and new.manual_submit_channel is distinct from new.submission_channel)
     or new.queue_state <> 'APPROVED_FOR_SEND'
     or verdict not in ('', 'PASS')
     or (verdict <> 'PASS' and coalesce(new.approved_by, '') not in ('fendi', 'grok_playlist_control'))
     or coalesce(new.submitted_by, '') not in ('fendi', 'grok_playlist_control') then
    raise exception 'pass_approval_required';
  end if;
  if new.packet ? 'route_hold' or new.packet ? 'review_defer' then raise exception 'record_held'; end if;
  e := new.packet->'submission_evidence';
  if e->>'result' is distinct from 'submitted' or nullif(trim(e->>'reference'), '') is null
     or nullif(trim(e->>'notes'), '') is null or (e->>'submitted_at')::timestamptz is distinct from new.submitted_at
     or new.submitted_at > now() + interval '1 minute' then
    raise exception 'submission_evidence_required';
  end if;
  select * into t from playlist_targets where playlist_id = new.playlist_target_id;
  perform pg_advisory_xact_lock(hashtextextended(coalesce(nullif(lower(trim(t.curator_email)), ''), agh_curator_form_key(t.form_url), t.playlist_id), 0));
  select sd.* into d from tracks tr join song_dna_versions sd on sd.id = tr.approved_song_dna_version_id
   where tr.id = new.track_id and sd.approval_state = 'approved';
  if d.id is null or d.id is distinct from new.song_dna_version_id or
     not coalesce(lower(trim(t.lane)) = any(d.approved_lanes), false) or
     coalesce(lower(trim(t.lane)) = any(d.excluded_lanes), false) then
    raise exception 'dna_gate';
  end if;
  v := agh_contact_policy(new.playlist_target_id, new.track_id, new.manual_submit_channel);
  if not coalesce((v->>'ok')::boolean, false) then raise exception 'playlist_policy:%', v->>'code'; end if;
  select name into title from tracks where id = new.track_id;
  insert into pitch_log(playlist_id, track_id, track_name, curator_email, method, status, sent_at, pitched_at, cooldown_until,
    song_dna_version_id, approved_by, approved_at, response_notes, dispatched_via)
  values(new.playlist_target_id, new.track_id, title,
    coalesce(nullif(trim(t.curator_email), ''), 'web-form:' || new.playlist_target_id || '@manual.invalid'),
    new.manual_submit_channel, 'sent', new.submitted_at, new.submitted_at,
    new.submitted_at + interval '90 days', d.id, new.approved_by, now(), e->>'notes', 'manual_evidence')
  returning id into pl;
  insert into agh_manual_submission_receipts(handoff_record_id, pitch_log_id, evidence, actor)
  values(new.id, pl, e, new.submitted_by);
  new.packet := new.packet || jsonb_build_object('submission_receipt', jsonb_build_object('pitch_log_id', pl, 'evidence', e));
  return new;
end $$;

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
  v_total int;
  v_awaiting int;
  v_reviewed int;
  v_rejected int;
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
  -- An already-approved batch stays approved. Individual records in it can still
  -- be approved or rejected. The batch itself is not moved backwards.
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
        v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('record_id',v_rec.id,'reason',coalesce(v_policy->>'code','pass_review_required')));
        continue;
      end if;
      update public.agh_handoff_records set queue_state='APPROVED_FOR_SEND',approved_by=p_actor,approved_by_label=p_actor_label,
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

revoke all on function public.agh_compose_rejection_reason(jsonb, text) from public, anon, authenticated;
grant execute on function public.agh_compose_rejection_reason(jsonb, text) to service_role;
revoke all on function public.agh_log_manual_submission() from public, anon, authenticated;
grant execute on function public.agh_log_manual_submission() to service_role;
revoke all on function public.agh_review_handoff_records(uuid, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.agh_review_handoff_records(uuid, jsonb, text, text) to service_role;

commit;
