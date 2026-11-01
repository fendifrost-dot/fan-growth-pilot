-- Unknown submission terms are not a send hold.
-- Apply via Lovable SQL Editor (paste, don't type). Do not apply via supabase CLI.
-- Apply this migration BEFORE redeploying execute-pitch, send-pitch-email,
-- and control-center-api. Those functions insert terms_status_at_send, and
-- web-form / Instagram receipt approval uses agh_contact_policy.
--
-- pitch_log.terms_status_at_send records free or unknown at send time.
-- It does not freeze the target. playlist_targets.submission_cost stays
-- editable (free | paid | tip_appreciated | unknown) through patch_target.
--
-- agh_contact_policy still blocks positive fee evidence (paid or any other
-- recorded non-free cost, a priced form, pay-to-play status or verdict, or
-- SubmitHub / Groover / Playlist Push / SubmitLink). Unknown and blank cost
-- stay eligible. Cooldown, dedupe, and the rest of the policy are unchanged.

begin;

alter table public.pitch_log
  add column if not exists terms_status_at_send text;

alter table public.pitch_log
  drop constraint if exists pitch_log_terms_status_at_send_chk;

alter table public.pitch_log
  add constraint pitch_log_terms_status_at_send_chk
  check (terms_status_at_send is null or terms_status_at_send in ('free', 'unknown'));

comment on column public.pitch_log.terms_status_at_send is
  'Submission terms at send time: free or unknown. Null on error rows and paid-platform receipts. Does not lock playlist_targets.submission_cost.';

create or replace function public.agh_terms_status_at_send(p_submission_cost text)
returns text
language sql
immutable
set search_path = public
as $$
  select case lower(trim(coalesce(p_submission_cost, '')))
    when 'free' then 'free'
    when '' then 'unknown'
    when 'unknown' then 'unknown'
    else null
  end
$$;

comment on function public.agh_terms_status_at_send(text) is
  'free or unknown for a pitch_log send stamp. Paid and tip return null.';

create or replace function public.agh_positive_submission_fee(
  p_submission_cost text,
  p_form_cost text,
  p_submission_method text,
  p_pitch_status text,
  p_fraud_verdict text,
  p_form_url text,
  p_submission_url text,
  p_website text,
  p_email text,
  p_evidence text
) returns boolean
language sql
immutable
set search_path = public
as $$
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
    or lower(
      coalesce(p_form_url, '') || ' ' ||
      coalesce(p_submission_url, '') || ' ' ||
      coalesce(p_website, '') || ' ' ||
      coalesce(p_email, '') || ' ' ||
      coalesce(p_evidence, '')
    ) ~ '(submithub\.com|groover\.co|playlistpush\.com|submitlink\.(io|com))|(^|[^a-z0-9])(submithub|playlistpush|playlist push|submitlink)([^a-z0-9]|$)';
$$;

comment on function public.agh_positive_submission_fee(text, text, text, text, text, text, text, text, text, text) is
  'True when a playlist row has positive fee evidence. Unknown and blank submission_cost are not evidence.';

create or replace function public.agh_contact_policy(p_target text, p_track uuid, p_channel text default null)
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
  ) then
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
    song_dna_version_id, approved_by, approved_at, response_notes, dispatched_via, terms_status_at_send)
  values(new.playlist_target_id, new.track_id, title,
    coalesce(nullif(trim(t.curator_email), ''), 'web-form:' || new.playlist_target_id || '@manual.invalid'),
    new.manual_submit_channel, 'sent', new.submitted_at, new.submitted_at,
    new.submitted_at + interval '90 days', d.id, new.approved_by, now(), e->>'notes', 'manual_evidence',
    public.agh_terms_status_at_send(t.submission_cost))
  returning id into pl;
  insert into agh_manual_submission_receipts(handoff_record_id, pitch_log_id, evidence, actor)
  values(new.id, pl, e, new.submitted_by);
  new.packet := new.packet || jsonb_build_object('submission_receipt', jsonb_build_object('pitch_log_id', pl, 'evidence', e));
  return new;
end $$;

do $$ declare r record; begin
  for r in select oid::regprocedure as signature from pg_proc where pronamespace = 'public'::regnamespace
    and proname in (
      'agh_terms_status_at_send',
      'agh_positive_submission_fee',
      'agh_contact_policy',
      'agh_log_manual_submission'
    )
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.signature);
    execute format('grant execute on function %s to service_role', r.signature);
  end loop;
end $$;

notify pgrst, 'reload schema';

commit;
