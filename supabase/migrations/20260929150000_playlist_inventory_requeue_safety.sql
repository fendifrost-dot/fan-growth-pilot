-- Follow-up to 20260928120000: keep mixed/ambiguous rejections and curator cooldowns
-- out of automatic fit requeue. Installs functions only; does not requeue any rows.
begin;

-- Structured codes are authoritative. Legacy prose is accepted only in the known
-- single-reason format; ambiguous prose remains rejected for individual review.
create or replace function public.agh_fit_requeue_reason_safe(p_packet jsonb, p_reason text)
returns boolean language sql immutable set search_path = public as $$
  select case
    when jsonb_typeof(p_packet->'rejection'->'reason_codes') = 'array'
         and jsonb_array_length(p_packet->'rejection'->'reason_codes') > 0 then
      not exists (
        select 1 from jsonb_array_elements_text(p_packet->'rejection'->'reason_codes') c
        where upper(trim(c)) not in ('DNA_LANE_MISMATCH', 'DNA_MISMATCH', 'LANE_MISMATCH',
          'GENRE_MISMATCH', 'DNA_LANE_NOT_APPROVED', 'LANE_NOT_APPROVED', 'LANE_NOT_ALLOWED',
          'WRONG_LANE', 'OFF_LANE') or c is null
      )
    else coalesce(trim(p_reason) ~* '^(FAILED[[:space:]—:-]+)?DNA_LANE_MISMATCH( Meditate hip_hop_rap only; lane=[a-z_]+)?$', false)
  end;
$$;
revoke all on function public.agh_fit_requeue_reason_safe(jsonb, text) from public, anon, authenticated;
grant execute on function public.agh_fit_requeue_reason_safe(jsonb, text) to service_role;

-- Same normalized form identity as curator-contact.ts: hostname + pathname,
-- excluding scheme/www/query/fragment/trailing slash, case-insensitive.
create or replace function public.agh_curator_form_key(p_url text)
returns text language sql immutable set search_path = public as $$
  select nullif(regexp_replace(regexp_replace(regexp_replace(lower(trim(p_url)),
    '^https?://(www\.)?', ''), '[?#].*$', ''), '/+$', ''), '');
$$;
revoke all on function public.agh_curator_form_key(text) from public, anon, authenticated;
grant execute on function public.agh_curator_form_key(text) to service_role;

-- Mirrors the existing per-song cooldown; no new cross-song contact restriction.
create or replace function public.agh_requeue_contact_cooldown(p_target text, p_track uuid)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare
  v_days numeric := 90;
  v_config text;
begin
  select value #>> '{}' into v_config from public.artist_config where key = 'cooldown_days';
  if v_config ~ '^[0-9]+(\.[0-9]+)?$' and v_config::numeric > 0 then
    v_days := v_config::numeric;
  end if;
  return exists (
    with target as (
      select * from public.playlist_targets where playlist_id = p_target
    ), siblings as (
      select p.playlist_id from public.playlist_targets p cross join target t
      where p.playlist_id = t.playlist_id
         or (nullif(lower(trim(t.curator_email)), '') is not null
             and lower(trim(p.curator_email)) = lower(trim(t.curator_email)))
         or (public.agh_curator_form_key(t.form_url) is not null
             and public.agh_curator_form_key(p.form_url) = public.agh_curator_form_key(t.form_url))
         or (nullif(lower(ltrim(trim(t.ig_curator_account), '@')), '') is not null
             and lower(ltrim(trim(p.ig_curator_account), '@')) = lower(ltrim(trim(t.ig_curator_account), '@')))
    )
    select 1 from public.agh_handoff_records r
      where r.track_id = p_track and r.playlist_target_id in (select playlist_id from siblings)
        and r.submitted_at + v_days * interval '1 day' > now()
    union all
    select 1 from public.pitch_log l
      where (l.track_id = p_track or lower(l.track_name) = (select lower(name) from public.tracks where id = p_track))
        and l.status = 'sent'
        and (l.playlist_id in (select playlist_id from siblings)
          or lower(trim(l.curator_email)) = (select nullif(lower(trim(curator_email)), '') from target))
        and coalesce(l.cooldown_until, coalesce(l.sent_at, l.pitched_at) + v_days * interval '1 day') > now()
  );
end;
$$;
revoke all on function public.agh_requeue_contact_cooldown(text, uuid) from public, anon, authenticated;
grant execute on function public.agh_requeue_contact_cooldown(text, uuid) to service_role;

-- A fresh explicit record review resolves a prior deferral. Keep review_history.
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
             packet = (packet - 'review_defer') || jsonb_build_object('review_history',
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
  -- Serialize repair invocations; row locks below also protect against review changes.
  if p_apply then perform pg_advisory_xact_lock(hashtext('agh_fit_rejection_requeue')); end if;
  for v_row in
    select r.id, r.batch_id, r.track_id, r.playlist_target_id, r.submission_channel, r.song_dna_version_id,
           r.outreach_draft_id, r.packet, r.rejection_reason, r.rejected_by_label, r.updated_at,
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
     for update of r
  loop
    v_skip := null;
    if not public.agh_fit_requeue_reason_safe(v_row.packet, v_row.why) then
      v_skip := 'other_or_ambiguous_rejection_reasons';
    elsif v_row.pt_id is null then
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
    elsif public.agh_requeue_contact_cooldown(v_row.pt_id, v_row.track_id) then
      v_skip := 'curator_cooldown_active';
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
