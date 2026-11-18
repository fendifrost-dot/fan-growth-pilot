-- Cut outreach gates Fendi never asked for (Fendi, 2026-11-18: "You are running a
-- business not a regulatory agency"). Default is send.
--
-- Kept: dedupe / 90-day cooldown, bounce suppression, blocked domains, Song DNA
-- excluded lanes, generated_by='fendi' protection (ATTRIBUTION_GAP), Meditate-only
-- sync, the Soundplate freeze (route_hold stays on Soundplate rows only), per-send
-- receipts, and PLC's own review_defer parking.
--
-- Changed: positive fee evidence is no longer an automatic fail. It returns
-- paid_for_fendi (ok=false), so it can never be approved, sent or paid
-- automatically; review stamps packet.paid_for_fendi so CoS can bring it to Fendi.
--
-- Cut:
--   * route_not_verified / missing_form_evidence / evidence_not_linked_to_form /
--     missing_ig_evidence in agh_route_failure_code (path_verified and
--     verification_status are no longer required; bounced/spam_flagged stays
--     suppressed as route_suppressed)
--   * 7-day re-verification aging (agh_age_pending_handoff_records is a no-op)
--   * 7-day last_verified_at staleness in agh_promote_claude_ready_batches
--   * path_verified and default-deny on unlisted/blank lanes in
--     agh_record_can_approve and agh_log_manual_submission (excluded lanes still block)
--   * approval no longer needs a separate "reviewed" step first
begin;

CREATE OR REPLACE FUNCTION public.agh_route_failure_code(p_channel text, p_verification_status text, p_path_verified boolean, p_curator_email text, p_form_url text, p_submission_url text, p_form_evidence text, p_ig_account text, p_ig_evidence text, p_source_url text DEFAULT NULL::text, p_is_active boolean DEFAULT NULL::boolean, p_route_method text DEFAULT NULL::text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
declare
  v_channel text := lower(nullif(trim(coalesce(p_channel, '')), ''));
  v_status text := lower(coalesce(trim(p_verification_status), ''));
  v_form text := coalesce(nullif(trim(p_form_url), ''), nullif(trim(p_submission_url), ''));
  v_host text;
  v_label text;
  v_src_label text;
  v_ev text;
  v_negation text :=
    '(\yno (submission )?(route|path|form|contact|email)s? (was |were )?(confirmed|found|available|listed|located|identified)\y)'
    || '|(\yno submission (route|path|form|option|method)\y)'
    || '|(\y(route|form|submission|contact) (is |was )?(not |un)(confirmed|verified|found|available)\y)'
    || '|(\ynot accepting submissions\y)'
    || '|(\ysubmissions? (are |is )?closed\y)'
    || '|(\yno (public )?(way|means) to submit\y)';
begin
  if p_is_active is false then
    return 'target_inactive';
  end if;
  if v_channel is null or v_channel not in ('email', 'web_form', 'instagram_dm') then
    return 'no_route_channel';
  end if;
  -- path_verified / verification_status are no longer required (cut 2026-11-18).
  if v_status in ('bounced', 'spam_flagged') then
    return 'route_suppressed';
  end if;

  if v_channel = 'email' then
    if nullif(trim(coalesce(p_curator_email, '')), '') is null then
      return 'missing_curator_email';
    end if;
    if trim(p_curator_email) !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
      return 'invalid_curator_email';
    end if;
    return null;
  end if;

  if v_channel = 'web_form' then
    if v_form is null then
      return 'missing_form_url';
    end if;
    if v_form !~* '^https?://[^/\s:?#]+' then
      return 'invalid_form_url';
    end if;
    v_host := regexp_replace(lower(substring(v_form from '^[A-Za-z]+://([^/:?#]+)')), '^www\.', '');
    if v_host = 'spotify.com' or v_host like '%.spotify.com' or v_host in ('spotify.link', 'spoti.fi') then
      return 'spotify_url_as_form';
    end if;
    if v_host in ('music.apple.com', 'music.youtube.com', 'deezer.com', 'deezer.page.link', 'tidal.com', 'listen.tidal.com')
       or v_host like '%.deezer.com' or v_host like '%.tidal.com' then
      return 'platform_url_as_form';
    end if;
    -- URL shape above still applies. A server_fetch pass already loaded the page,
    -- so agent evidence text is not re-checked.
    if lower(trim(coalesce(p_route_method, ''))) = 'server_fetch' then
      return null;
    end if;
    -- Evidence text is a hint, not a gate (cut 2026-11-18). Only evidence that
    -- says there is no route still fails.
    v_ev := nullif(trim(coalesce(p_form_evidence, '')), '');
    if v_ev is not null and v_ev ~* v_negation then
      return 'evidence_negates_route';
    end if;
    return null;
  end if;

  -- instagram_dm
  if nullif(trim(coalesce(p_ig_account, '')), '') is null then
    return 'missing_ig_account';
  end if;
  if trim(p_ig_account) !~ '^@?[A-Za-z0-9._]{2,30}$' then
    return 'invalid_ig_account';
  end if;
    -- URL shape above still applies. A server_fetch pass already loaded the page,
    -- so agent evidence text is not re-checked.
    if lower(trim(coalesce(p_route_method, ''))) = 'server_fetch' then
      return null;
    end if;
  v_ev := nullif(trim(coalesce(p_ig_evidence, '')), '');
  if v_ev is not null and v_ev ~* v_negation then
    return 'evidence_negates_route';
  end if;
  return null;
end;
$function$;

CREATE OR REPLACE FUNCTION public.agh_contact_policy(p_target text, p_track uuid, p_channel text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  t playlist_targets%rowtype;
  ids text[];
  expiry timestamptz;
  conflict_id uuid;
  channel text := coalesce(nullif(lower(trim(p_channel)), ''), 'email');
  owner_key text;
  group_key text;
  ig_key text;
begin
  select * into t from playlist_targets where playlist_id = p_target;
  if not found or p_track is null then
    return jsonb_build_object('ok', false, 'code', 'identity_required');
  end if;

  owner_key := agh_spotify_owner_key(t.spotify_owner_id, t.research_context);
  group_key := nullif(lower(trim(t.operator_group_id)), '');
  ig_key := agh_curator_ig_key(t.ig_curator_account, t.curator_instagram);

  select array_agg(distinct p.playlist_id) into ids
    from playlist_targets p
   where p.playlist_id = t.playlist_id
      or (
        agh_spotify_playlist_key(p.playlist_id) is not null
        and agh_spotify_playlist_key(p.playlist_id) = agh_spotify_playlist_key(t.playlist_id)
      )
      or (
        nullif(trim(t.curator_email), '') is not null
        and lower(trim(p.curator_email)) = lower(trim(t.curator_email))
      )
      or (
        agh_curator_form_key(t.form_url) is not null
        and agh_curator_form_key(p.form_url) = agh_curator_form_key(t.form_url)
      )
      or (
        ig_key is not null
        and agh_curator_ig_key(p.ig_curator_account, p.curator_instagram) = ig_key
      )
      or (
        group_key is not null
        and lower(trim(p.operator_group_id)) = group_key
      )
      or (
        owner_key is not null
        and agh_spotify_owner_key(p.spotify_owner_id, p.research_context) = owner_key
      );
  ids := coalesce(ids, array[t.playlist_id]);

  if t.is_active is false then return jsonb_build_object('ok', false, 'code', 'inactive_target'); end if;
  if exists(
    select 1
      from playlist_targets p
     where p.playlist_id = any(ids)
       and public.agh_positive_submission_fee(
         p.submission_cost,
         p.form_cost,
         p.submission_method,
         p.pitch_status,
         p.fraud_verdict,
         p.form_url,
         p.submission_url,
         p.curator_website,
         p.curator_email,
         concat_ws(' ', p.form_source_evidence, p.ig_source_evidence)
       )
       or coalesce(p.research_context #>> '{route_fetch,signals,paywall_or_pay_to_play}', '') = 'true'
  ) then
    -- Not an automatic fail any more: held for Fendi's yes/no. ok stays false, so
    -- nothing paid is ever approved, sent or paid automatically.
    return jsonb_build_object('ok', false, 'code', 'paid_for_fendi');
  end if;
  if exists(select 1 from playlist_targets p join domain_blocklist b on
    lower(split_part(p.curator_email, '@', 2)) = lower(trim(b.domain))
    or lower(split_part(p.curator_email, '@', 2)) like '%.' || lower(trim(b.domain))
    where p.playlist_id = any(ids)) then
    return jsonb_build_object('ok', false, 'code', 'blocked_domain');
  end if;
  -- Email deliverability must not close a form or DM route.
  if channel = 'email' then
    if exists(select 1 from playlist_targets where playlist_id = any(ids)
      and (bounce_count > 0 or verification_status in ('bounced', 'blocked', 'invalid'))) then
      return jsonb_build_object('ok', false, 'code', 'suppressed_curator');
    end if;
  elsif exists(select 1 from playlist_targets where playlist_id = any(ids)
    and verification_status in ('blocked', 'invalid')) then
    return jsonb_build_object('ok', false, 'code', 'suppressed_curator');
  end if;

  -- Any real send to this curator, on any channel and either song, cools the
  -- whole identity. Bounced and error rows do not.
  select h.pitch_log_id, h.expiry
    into conflict_id, expiry
    from (
      select l.id as pitch_log_id,
             greatest(l.cooldown_until, coalesce(l.sent_at, l.pitched_at) + interval '90 days') as expiry
        from pitch_log l
       where lower(coalesce(l.status, '')) not in ('bounced', 'error')
         and (
           l.cooldown_until is not null
           or nullif(trim(l.resend_message_id), '') is not null
           or lower(l.status) in ('sent', 'responded', 'replied', 'rejected')
         )
         and (
           l.playlist_id = any(ids)
           or (
             agh_spotify_playlist_key(l.playlist_id) is not null
             and agh_spotify_playlist_key(l.playlist_id) in (
               select agh_spotify_playlist_key(s) from unnest(ids) s
             )
           )
           or (
             nullif(trim(l.curator_email), '') is not null
             and lower(trim(l.curator_email)) in (
               select lower(trim(p.curator_email))
                 from playlist_targets p
                where p.playlist_id = any(ids)
                  and nullif(trim(p.curator_email), '') is not null
             )
           )
         )
      union all
      select mr.pitch_log_id,
             r.submitted_at + interval '90 days'
        from agh_handoff_records r
        left join agh_manual_submission_receipts mr on mr.handoff_record_id = r.id
       where r.playlist_target_id = any(ids)
         and r.submitted_at is not null
    ) h
   where h.expiry > now()
   order by (h.pitch_log_id is null), h.expiry desc
   limit 1;

  if expiry > now() then
    return jsonb_build_object(
      'ok', false,
      'code', 'cooldown_conflict',
      'pitch_log_id', conflict_id,
      'cooldown_until', expiry
    );
  end if;
  return jsonb_build_object('ok', true, 'code', 'eligible');
end $function$;

CREATE OR REPLACE FUNCTION public.agh_age_pending_handoff_records(p_dry_run boolean DEFAULT true, p_max_age interval DEFAULT '7 days'::interval)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- Cut 2026-11-18 (Fendi): records awaiting review are no longer sent back for
  -- route re-verification after 7 days. Kept as a no-op so the hourly
  -- agh_handoff_backlog_maintenance call and older clients keep working.
  return jsonb_build_object(
    'ok', true,
    'dry_run', p_dry_run,
    'max_age', p_max_age,
    'pending_records', 0,
    'record_ids', '[]'::jsonb,
    'batch_ids', '[]'::jsonb,
    'held', '[]'::jsonb,
    'retired', true,
    'note', 'Retired 2026-11-18: no 7-day re-verification aging.'
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.agh_promote_claude_ready_batches(p_dry_run boolean DEFAULT true, p_business_date date DEFAULT NULL::date, p_batch_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
          v_target.is_active,
          nullif(v_target.research_context #>> '{route_fetch,method}', ''));
        -- No 7-day staleness (cut 2026-11-18). A record is held back only when it
        -- has no usable contact (agh_route_failure_code) or still carries a
        -- route_hold, which after 2026-11-18 only Soundplate-freeze rows do.
        v_stale := v_rec.packet ? 'route_hold'
          or v_fail is not null;
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
        'reason', 'No usable contact for the channel (or Soundplate freeze); held instead of promotion'
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
    'note', 'Only records with no usable contact (or a Soundplate-freeze hold) stay back. Promotion stops at AWAITING_GROK_REVIEW.'
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.agh_record_can_approve(p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r agh_handoff_records%rowtype; t playlist_targets%rowtype; d song_dna_versions%rowtype; v jsonb;
begin
  select * into r from agh_handoff_records where id = p_id;
  -- One review step: a record awaiting review can be approved directly (2026-11-18).
  if not found or r.queue_state not in ('AWAITING_GROK_REVIEW', 'GROK_REVIEWED') or r.submitted_at is not null then
    return jsonb_build_object('ok', false, 'code', 'review_required');
  end if;
  if r.packet ? 'route_hold' or r.packet ? 'review_defer' then
    return jsonb_build_object('ok', false, 'code', 'record_held');
  end if;
  if exists(select 1 from outreach_drafts where id = r.outreach_draft_id and generated_by = 'fendi') then
    return jsonb_build_object('ok', false, 'code', 'ATTRIBUTION_GAP');
  end if;
  select * into t from playlist_targets where playlist_id = r.playlist_target_id;
  select sd.* into d from tracks tr join song_dna_versions sd on sd.id = tr.approved_song_dna_version_id
   where tr.id = r.track_id and sd.approval_state = 'approved';
  -- Excluded lanes still block; blank or unlisted lanes do not (cut 2026-11-18).
  if d.id is null or d.id is distinct from r.song_dna_version_id or
     coalesce(lower(trim(t.lane)) = any(d.excluded_lanes), false) then
    return jsonb_build_object('ok', false, 'code', 'dna_gate');
  end if;
  -- path_verified is no longer required; a usable contact for the channel is.
  v := to_jsonb(public.agh_route_failure_code(
    r.submission_channel,
    t.verification_status, t.path_verified, t.curator_email, t.form_url, t.submission_url,
    t.form_source_evidence, coalesce(t.ig_curator_account, t.curator_instagram), t.ig_source_evidence,
    null, t.is_active, nullif(t.research_context #>> '{route_fetch,method}', '')));
  if v is not null and v <> 'null'::jsonb then
    return jsonb_build_object('ok', false, 'code', v #>> '{}');
  end if;
  return agh_contact_policy(r.playlist_target_id, r.track_id, r.submission_channel);
end $function$;

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
$function$;

CREATE OR REPLACE FUNCTION public.agh_log_manual_submission()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  e jsonb;
  t playlist_targets%rowtype;
  d song_dna_versions%rowtype;
  v jsonb;
  pl uuid;
  title text;
  verdict text;
  v_sent_by text;
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
  perform pg_advisory_xact_lock(hashtextextended(coalesce(
    nullif(lower(trim(t.operator_group_id)), ''),
    nullif(trim(t.spotify_owner_id), ''),
    nullif(lower(trim(t.curator_email)), ''),
    agh_curator_form_key(t.form_url),
    agh_spotify_playlist_key(t.playlist_id),
    t.playlist_id
  ), 0));
  select sd.* into d from tracks tr join song_dna_versions sd on sd.id = tr.approved_song_dna_version_id
   where tr.id = new.track_id and sd.approval_state = 'approved';
  -- Excluded lanes still block; blank or unlisted lanes do not (cut 2026-11-18).
  if d.id is null or d.id is distinct from new.song_dna_version_id or
     coalesce(lower(trim(t.lane)) = any(d.excluded_lanes), false) then
    raise exception 'dna_gate';
  end if;
  v := agh_contact_policy(new.playlist_target_id, new.track_id, new.manual_submit_channel);
  perform agh_raise_contact_policy(v);
  select name into title from tracks where id = new.track_id;
  -- Same convention as execute-pitch: the acting agent, not a caller-supplied
  -- body field. submitted_by is the credential that stamped the receipt.
  v_sent_by := coalesce(nullif(trim(new.submitted_by), ''), nullif(trim(new.approved_by), ''));
  insert into pitch_log(playlist_id, track_id, track_name, curator_email, method, status, sent_at, pitched_at, cooldown_until,
    song_dna_version_id, approved_by, approved_at, response_notes, dispatched_via, terms_status_at_send,
    sent_by, audit_result)
  values(new.playlist_target_id, new.track_id, title,
    coalesce(nullif(trim(t.curator_email), ''), 'web-form:' || new.playlist_target_id || '@manual.invalid'),
    new.manual_submit_channel, 'sent', new.submitted_at, new.submitted_at,
    new.submitted_at + interval '90 days', d.id, new.approved_by, now(), e->>'notes', 'manual_evidence',
    public.agh_terms_status_at_send(t.submission_cost),
    v_sent_by, 'PASS')
  returning id into pl;
  insert into agh_manual_submission_receipts(handoff_record_id, pitch_log_id, evidence, actor)
  values(new.id, pl, e, new.submitted_by);
  new.packet := new.packet || jsonb_build_object('submission_receipt', jsonb_build_object('pitch_log_id', pl, 'evidence', e));
  return new;
end $function$;


-- Paid offers waiting on Fendi: open records held paid_for_fendi plus targets with
-- positive fee evidence. Read-only; nothing here sends or pays.
create or replace view public.agh_paid_for_fendi_queue as
select r.id as handoff_record_id, r.batch_id, r.track_id, r.playlist_target_id,
       r.submission_channel, r.queue_state, r.packet->'paid_for_fendi' as hold,
       t.playlist_name, t.curator_name, t.curator_email, t.form_url, t.submission_url,
       t.submission_cost, t.form_cost, t.follower_count, t.lane
  from public.agh_handoff_records r
  join public.playlist_targets t on t.playlist_id = r.playlist_target_id
 where r.submitted_at is null
   and r.packet ? 'paid_for_fendi';
revoke all on public.agh_paid_for_fendi_queue from anon, authenticated;

commit;
