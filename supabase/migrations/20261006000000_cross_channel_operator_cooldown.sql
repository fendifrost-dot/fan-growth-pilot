-- A sent pitch cooled only the playlist row, email, or IG handle that shared
-- an exact sibling key. An IG handoff for a Spotify playlist already pitched
-- by email (Sphere of Hip-Hop, Best Underground Rap) and a second Spotify
-- account run by the same operator could still be approved.
--
-- Cooldown is 90 days per curator across every channel and both songs. The
-- curator is the Spotify playlist id, the contact email, the IG handle, the
-- submission form, the Spotify owner id, or an explicit operator_group_id.
-- A bounce is still not a delivery. Historical pitch_log rows are not rewritten.
begin;

alter table public.playlist_targets
  add column if not exists operator_group_id text,
  add column if not exists spotify_owner_id text;

create index if not exists playlist_targets_operator_group_id_idx
  on public.playlist_targets (lower(operator_group_id))
  where operator_group_id is not null;

create index if not exists playlist_targets_spotify_owner_id_idx
  on public.playlist_targets (spotify_owner_id)
  where spotify_owner_id is not null;

-- Copy an owner id that enrichment already stored. Do not overwrite a value
-- Chief of Staff set by hand.
update public.playlist_targets
   set spotify_owner_id = nullif(trim(research_context->>'spotify_owner_id'), '')
 where spotify_owner_id is null
   and nullif(trim(research_context->>'spotify_owner_id'), '') is not null;

-- One operator runs the Playlist Curator Submission accounts. Only fill rows
-- that do not already have a group, so a later manual edit sticks.
update public.playlist_targets
   set operator_group_id = 'playlistpumppragency'
 where operator_group_id is null
   and (
     lower(trim(coalesce(curator_email, ''))) = 'playlistpumppragency@gmail.com'
     or lower(ltrim(coalesce(ig_curator_account, ''), '@')) in (
       'playlistcuratorssubmission', 'playlistcuratorsubmission', 'playlistcuratorspotifyofficial'
     )
     or lower(ltrim(coalesce(curator_instagram, ''), '@')) in (
       'playlistcuratorssubmission', 'playlistcuratorsubmission', 'playlistcuratorspotifyofficial'
     )
   );

create or replace function public.agh_spotify_playlist_key(p_id text)
returns text
language sql
immutable
as $$
  select case
    when k ~ '^[A-Za-z0-9]{22}$' then k
    else null
  end
  from (select regexp_replace(trim(coalesce(p_id, '')), '^spotify:(playlist:)?', '') as k) s;
$$;

create or replace function public.agh_curator_ig_key(p_account text, p_instagram text)
returns text
language sql
immutable
as $$
  select nullif(lower(ltrim(coalesce(nullif(trim(p_account), ''), nullif(trim(p_instagram), ''), ''), '@')), '');
$$;

create or replace function public.agh_spotify_owner_key(p_owner text, p_context jsonb)
returns text
language sql
immutable
as $$
  select nullif(trim(coalesce(
    nullif(trim(p_owner), ''),
    nullif(trim(p_context->>'spotify_owner_id'), '')
  )), '');
$$;

create or replace function public.agh_raise_contact_policy(p_policy jsonb)
returns void
language plpgsql
as $$
begin
  if coalesce((p_policy->>'ok')::boolean, false) then
    return;
  end if;
  if p_policy->>'code' = 'cooldown_conflict' and nullif(p_policy->>'pitch_log_id', '') is not null then
    raise exception 'playlist_policy:cooldown_conflict:%', p_policy->>'pitch_log_id';
  end if;
  raise exception 'playlist_policy:%', coalesce(nullif(p_policy->>'code', ''), 'blocked');
end $$;

drop function if exists public.agh_contact_policy(text, uuid, text);
drop function if exists public.agh_contact_policy(text, uuid);

create function public.agh_contact_policy(p_target text, p_track uuid, p_channel text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
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
  if exists(select 1 from playlist_targets where playlist_id = any(ids) and submission_cost = 'paid') then
    return jsonb_build_object('ok', false, 'code', 'paid_curator');
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
end $$;

create or replace function public.agh_guard_draft_policy() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v jsonb;
begin
  if TG_OP = 'UPDATE' and new.status is not distinct from old.status then return new; end if;
  if TG_OP = 'UPDATE' and new.status not in ('pending', 'approved') then return new; end if;
  if TG_OP = 'UPDATE' and new.status = 'approved' and new.generated_by = 'fendi' then
    raise exception 'ATTRIBUTION_GAP: existing attribution hold';
  end if;
  v := agh_contact_policy(new.playlist_id, new.track_id, new.channel);
  perform agh_raise_contact_policy(v);
  return new;
end $$;

create or replace function public.agh_log_manual_submission() returns trigger
language plpgsql
security definer
set search_path = public
as $$
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
  if d.id is null or d.id is distinct from new.song_dna_version_id or
     not coalesce(lower(trim(t.lane)) = any(d.approved_lanes), false) or
     coalesce(lower(trim(t.lane)) = any(d.excluded_lanes), false) then
    raise exception 'dna_gate';
  end if;
  v := agh_contact_policy(new.playlist_target_id, new.track_id, new.manual_submit_channel);
  perform agh_raise_contact_policy(v);
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

do $$ declare r record; begin
  for r in select oid::regprocedure signature from pg_proc where pronamespace = 'public'::regnamespace
    and proname in (
      'agh_contact_policy', 'agh_guard_draft_policy', 'agh_log_manual_submission',
      'agh_review_handoff_records', 'agh_raise_contact_policy',
      'agh_spotify_playlist_key', 'agh_curator_ig_key', 'agh_spotify_owner_key'
    )
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.signature);
    execute format('grant execute on function %s to service_role', r.signature);
  end loop;
end $$;

notify pgrst, 'reload schema';
commit;
