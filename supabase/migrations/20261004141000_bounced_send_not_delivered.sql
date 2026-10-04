-- A Resend bounce leaves pitch_log.status = 'bounced' but the row still has
-- resend_message_id and cooldown_until. Quota and curator cooldown treated
-- that as a delivery, which also blocked other channels (IG DM, web form).
-- Bounced and error rows count toward neither. An email bounce suppresses
-- further email only. Existing rows are not rewritten.
begin;

drop function if exists public.agh_contact_policy(text, uuid, text);
drop function if exists public.agh_contact_policy(text, uuid);

create function public.agh_contact_policy(p_target text, p_track uuid, p_channel text default null)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  t playlist_targets%rowtype;
  ids text[];
  expiry timestamptz;
  channel text := coalesce(nullif(lower(trim(p_channel)), ''), 'email');
begin
  select * into t from playlist_targets where playlist_id = p_target;
  if not found or p_track is null then
    return jsonb_build_object('ok', false, 'code', 'identity_required');
  end if;
  select array_agg(p.playlist_id) into ids from playlist_targets p where
    regexp_replace(p.playlist_id, '^spotify:(playlist:)?', '') = regexp_replace(t.playlist_id, '^spotify:(playlist:)?', '')
    or (nullif(trim(t.curator_email), '') is not null and lower(trim(p.curator_email)) = lower(trim(t.curator_email)))
    or (agh_curator_form_key(t.form_url) is not null and agh_curator_form_key(p.form_url) = agh_curator_form_key(t.form_url))
    or (nullif(lower(ltrim(t.ig_curator_account, '@')), '') is not null
        and lower(ltrim(p.ig_curator_account, '@')) = lower(ltrim(t.ig_curator_account, '@')));
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
  select max(u) into expiry from (
    select greatest(cooldown_until, coalesce(sent_at, pitched_at) + interval '90 days') u
      from pitch_log l
     where (l.playlist_id = any(ids)
            or (nullif(trim(t.curator_email), '') is not null
                and lower(trim(l.curator_email)) = lower(trim(t.curator_email))))
       and lower(coalesce(l.status, '')) not in ('bounced', 'error')
       and (l.cooldown_until is not null
            or l.resend_message_id is not null
            or lower(l.status) in ('sent', 'responded', 'replied', 'rejected'))
    union all
    select submitted_at + interval '90 days'
      from agh_handoff_records
     where playlist_target_id = any(ids) and submitted_at is not null
  ) c;
  if expiry > now() then
    return jsonb_build_object('ok', false, 'code', 'curator_cooldown', 'cooldown_until', expiry);
  end if;
  return jsonb_build_object('ok', true, 'code', 'eligible');
end $$;

create or replace function public.agh_guard_draft_policy() returns trigger
language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  if TG_OP = 'UPDATE' and new.status is not distinct from old.status then return new; end if;
  if TG_OP = 'UPDATE' and new.status not in ('pending', 'approved') then return new; end if;
  if TG_OP = 'UPDATE' and new.status = 'approved' and new.generated_by = 'fendi' then
    raise exception 'ATTRIBUTION_GAP: existing attribution hold';
  end if;
  v := agh_contact_policy(new.playlist_id, new.track_id, new.channel);
  if not coalesce((v->>'ok')::boolean, false) then raise exception 'playlist_policy:%', v->>'code'; end if;
  return new;
end $$;

create or replace function public.agh_record_can_approve(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r agh_handoff_records%rowtype; t playlist_targets%rowtype; d song_dna_versions%rowtype; v jsonb;
begin
  select * into r from agh_handoff_records where id = p_id;
  if not found or r.queue_state <> 'GROK_REVIEWED' or r.submitted_at is not null then
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
  if d.id is null or d.id is distinct from r.song_dna_version_id or
     not coalesce(lower(trim(t.lane)) = any(d.approved_lanes), false) or
     coalesce(lower(trim(t.lane)) = any(d.excluded_lanes), false) then
    return jsonb_build_object('ok', false, 'code', 'dna_gate');
  end if;
  if t.path_verified is not true then return jsonb_build_object('ok', false, 'code', 'route_unverified'); end if;
  return agh_contact_policy(r.playlist_target_id, r.track_id, r.submission_channel);
end $$;

create or replace function public.agh_log_manual_submission() returns trigger
language plpgsql security definer set search_path = public as $$
declare e jsonb; t playlist_targets%rowtype; d song_dna_versions%rowtype; v jsonb; pl uuid; title text;
begin
  if new.submitted_at is null or old.submitted_at is not null then return new; end if;
  if new.manual_submit_channel not in ('web_form', 'instagram_dm') or new.manual_submit_channel is distinct from new.submission_channel
     or new.queue_state <> 'APPROVED_FOR_SEND' or new.packet->'grok_review'->>'verdict' is distinct from 'PASS'
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
  values(new.playlist_target_id, new.track_id, title, t.curator_email, new.manual_submit_channel, 'sent', new.submitted_at, new.submitted_at,
    new.submitted_at + interval '90 days', d.id, new.approved_by, now(), e->>'notes', 'manual_evidence')
  returning id into pl;
  insert into agh_manual_submission_receipts(handoff_record_id, pitch_log_id, evidence, actor)
  values(new.id, pl, e, new.submitted_by);
  new.packet := new.packet || jsonb_build_object('submission_receipt', jsonb_build_object('pitch_log_id', pl, 'evidence', e));
  return new;
end $$;

create or replace function public.agh_pipeline_quota(p_track uuid default null) returns jsonb
language sql stable security definer set search_path = public as $$
  with day as (select (now() at time zone 'America/Chicago')::date ct), totals as (
    select t.id track_id, t.name title, day.ct business_date_ct,
      (select count(*) from pitch_log l
        where l.track_id = t.id and lower(l.status) = 'sent' and l.resend_message_id is not null
          and (l.sent_at at time zone 'America/Chicago')::date = day.ct) submissions_email_today,
      (select count(*) from agh_manual_submission_receipts mr
        join pitch_log l on l.id = mr.pitch_log_id
        where l.track_id = t.id and lower(l.status) = 'sent'
          and (l.sent_at at time zone 'America/Chicago')::date = day.ct) submissions_manual_today,
      (select count(*) from outreach_drafts od where od.track_id = t.id and od.status = 'pending') drafts_awaiting_review,
      (select count(*) from outreach_drafts od where od.track_id = t.id and od.status = 'pending'
          and (od.created_at at time zone 'America/Chicago')::date = day.ct) drafts_awaiting_review_today
    from tracks t cross join day
    where t.status = 'active' and (p_track is null or t.id = p_track))
  select coalesce(jsonb_agg(to_jsonb(totals) || jsonb_build_object(
    'objective_submissions', 30,
    'submissions_today', submissions_email_today + submissions_manual_today,
    'submission_shortfall', greatest(0, 30 - submissions_email_today - submissions_manual_today))), '[]'::jsonb)
  from totals;
$$;

do $$ declare r record; begin
  for r in select oid::regprocedure signature from pg_proc where pronamespace = 'public'::regnamespace
    and proname in ('agh_contact_policy', 'agh_guard_draft_policy', 'agh_record_can_approve', 'agh_log_manual_submission', 'agh_pipeline_quota')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.signature);
    execute format('grant execute on function %s to service_role', r.signature);
  end loop;
end $$;

notify pgrst, 'reload schema';
commit;
