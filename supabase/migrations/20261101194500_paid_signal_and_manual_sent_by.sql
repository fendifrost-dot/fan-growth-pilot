-- Paid-platform matching was tripping on verify notes that only named
-- SubmitHub, Groover, Playlist Push, or SubmitLink. Match a submission host,
-- a platform email, or an explicit fee phrase. A negated or "not found" note
-- is not a fee.
--
-- Manual form and Instagram receipts insert pitch_log from
-- agh_log_manual_submission. Stamp sent_by and audit_result the same way
-- execute-pitch does, and backfill the one live row whose id starts with
-- 1a924810.
--
-- Apply via Lovable SQL Editor (paste, don't type). Do not apply via supabase CLI.
-- Apply this migration BEFORE redeploying execute-pitch, send-pitch-email,
-- and control-center-api.

begin;

create or replace function public.agh_url_host(p_value text)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  v text := lower(btrim(coalesce(p_value, '')));
  host text;
begin
  if v = '' or v ~ '[[:space:]]' then
    return '';
  end if;
  if position('@' in v) > 0 and v !~ '^https?://' then
    v := split_part(v, '@', 2);
  end if;
  if v !~ '^https?://' then
    v := 'https://' || v;
  end if;
  host := substring(v from '^https?://([^/:?#]+)');
  return regexp_replace(coalesce(host, ''), '^www\.', '');
end;
$$;

create or replace function public.agh_host_is_paid_platform(p_host text)
returns boolean
language sql
immutable
set search_path = public
as $$
  select p_host in (
      'submithub.com', 'groover.co', 'playlistpush.com', 'submitlink.io', 'submitlink.com'
    )
    or p_host like '%.submithub.com'
    or p_host like '%.groover.co'
    or p_host like '%.playlistpush.com'
    or p_host like '%.submitlink.io'
    or p_host like '%.submitlink.com';
$$;

create or replace function public.agh_text_has_submission_fee(p_text text)
returns boolean
language plpgsql
immutable
set search_path = public
as $$
declare
  clause text;
  fee text := '[$€£][[:space:]]*[1-9]|[0-9]+(\.[0-9]+)?[[:space:]]*(usd|eur|gbp|credits)\y|\ybuy[[:space:]]+credits\y|\ycredits[[:space:]]+(required|to[[:space:]]+submit)\y|\ypremium[[:space:]]+submission\y|\ypaid[[:space:]]+(review|submission|placement|promo|package)\y|\yper[[:space:]]+(submission|review|song|track)\y|\y(submission|placement|review)[[:space:]]+fee\y|\ypay[[:space:]]+to[[:space:]]+(submit|play)\y';
  neg text := '\y(no|not|none|without|never)\y|different[[:space:]]+curator|none[[:space:]]+found|not[[:space:]]+found|no[[:space:]]+listing';
begin
  if p_text is null or btrim(p_text) = '' then
    return false;
  end if;
  for clause in
    select btrim(part)
    from regexp_split_to_table(lower(p_text), '[.;' || chr(10) || ']+') as part
  loop
    if clause = '' then
      continue;
    end if;
    if clause ~ fee and clause !~ neg then
      return true;
    end if;
  end loop;
  return false;
end;
$$;

create or replace function public.agh_evidence_has_paid_signal(p_text text)
returns boolean
language plpgsql
immutable
set search_path = public
as $$
declare
  token text;
begin
  if public.agh_text_has_submission_fee(p_text) then
    return true;
  end if;
  for token in
    select part
    from regexp_split_to_table(coalesce(p_text, ''), '[[:space:]]+') as part
    where part ~* '^https?://'
  loop
    if public.agh_host_is_paid_platform(public.agh_url_host(token)) then
      return true;
    end if;
  end loop;
  return false;
end;
$$;

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
    or public.agh_host_is_paid_platform(public.agh_url_host(p_form_url))
    or public.agh_host_is_paid_platform(public.agh_url_host(p_submission_url))
    or public.agh_host_is_paid_platform(public.agh_url_host(p_website))
    or public.agh_host_is_paid_platform(public.agh_url_host(p_email))
    or public.agh_evidence_has_paid_signal(p_evidence);
$$;

comment on function public.agh_positive_submission_fee(text, text, text, text, text, text, text, text, text, text) is
  'True for a recorded non-free cost, a pay-to-play mark, a paid-platform host or email, or an explicit submission fee. Platform names in free text are not evidence.';

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
  if d.id is null or d.id is distinct from new.song_dna_version_id or
     not coalesce(lower(trim(t.lane)) = any(d.approved_lanes), false) or
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
end $$;

-- The id was reported by prefix. Fill only the fields that are still null.
update public.pitch_log
   set sent_by = coalesce(sent_by, 'grok_playlist_control'),
       audit_result = coalesce(audit_result, 'PASS')
 where id::text like '1a924810%'
   and (sent_by is null or audit_result is null);

do $$ declare r record; begin
  for r in select oid::regprocedure as signature from pg_proc where pronamespace = 'public'::regnamespace
    and proname in (
      'agh_url_host',
      'agh_host_is_paid_platform',
      'agh_text_has_submission_fee',
      'agh_evidence_has_paid_signal',
      'agh_positive_submission_fee',
      'agh_log_manual_submission'
    )
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.signature);
    execute format('grant execute on function %s to service_role', r.signature);
  end loop;
end $$;

notify pgrst, 'reload schema';

commit;
