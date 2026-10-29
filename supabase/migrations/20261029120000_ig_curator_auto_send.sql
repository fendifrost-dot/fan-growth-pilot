-- Automatic Instagram curator send log.
-- Source of truth only. Do not apply from this PR. Paste in Lovable SQL Editor
-- when the matching edge functions are deployed.
--
-- One row per song + Instagram handle. The claim is inserted before the Graph
-- call. A second dispatcher sees the row and does not send again.

create table if not exists public.agh_ig_dm_send_log (
  id uuid primary key default gen_random_uuid(),
  claim_key text not null unique,
  handoff_record_id uuid not null,
  track_id uuid not null,
  ig_handle text not null,
  status text not null check (status in ('claimed', 'sent', 'failed')),
  provider_message_id text,
  failure_code text,
  claimed_at timestamptz not null default now(),
  finished_at timestamptz
);

create index if not exists agh_ig_dm_send_log_claimed_at
  on public.agh_ig_dm_send_log (claimed_at)
  where status in ('claimed', 'sent');

alter table public.agh_ig_dm_send_log enable row level security;

drop policy if exists "Deny anon on agh_ig_dm_send_log" on public.agh_ig_dm_send_log;
create policy "Deny anon on agh_ig_dm_send_log"
  on public.agh_ig_dm_send_log for all to anon using (false);

drop policy if exists "Deny authenticated direct on agh_ig_dm_send_log" on public.agh_ig_dm_send_log;
create policy "Deny authenticated direct on agh_ig_dm_send_log"
  on public.agh_ig_dm_send_log for all to authenticated using (false);

comment on table public.agh_ig_dm_send_log is
  'Atomic claim for automatic Instagram curator DMs. One claim_key (track_id:handle) ever. claimed/sent/failed. A retry must not send again.';

-- Allow the automatic sender to stamp a receipt. The previous trigger only
-- accepted submitted_by fendi or grok_playlist_control, which is the manual path.
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
  actor text;
begin
  if new.submitted_at is null or old.submitted_at is not null then return new; end if;
  verdict := coalesce(new.packet->'grok_review'->>'verdict', '');
  actor := coalesce(new.submitted_by, '');
  if new.manual_submit_channel not in ('web_form', 'instagram_dm')
     or (new.submission_channel is not null and new.manual_submit_channel is distinct from new.submission_channel)
     or new.queue_state <> 'APPROVED_FOR_SEND'
     or verdict not in ('', 'PASS')
     or (verdict <> 'PASS' and coalesce(new.approved_by, '') not in ('fendi', 'grok_playlist_control'))
     or actor not in ('fendi', 'grok_playlist_control', 'ig_curator_auto_send') then
    raise exception 'pass_approval_required';
  end if;
  if actor = 'ig_curator_auto_send' and new.manual_submit_channel is distinct from 'instagram_dm' then
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
    new.submitted_at + interval '90 days', d.id, new.approved_by, now(), e->>'notes',
    case when actor = 'ig_curator_auto_send' then 'instagram_graph' else 'manual_evidence' end)
  returning id into pl;
  insert into agh_manual_submission_receipts(handoff_record_id, pitch_log_id, evidence, actor)
  values(new.id, pl, e, actor);
  new.packet := new.packet || jsonb_build_object('submission_receipt', jsonb_build_object('pitch_log_id', pl, 'evidence', e));
  return new;
end $$;

create or replace function public.agh_claim_ig_curator_send(
  p_key text,
  p_handoff uuid,
  p_track uuid,
  p_handle text,
  p_cap int,
  p_day_start timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  existing public.agh_ig_dm_send_log%rowtype;
  used int;
  handle text := lower(regexp_replace(coalesce(p_handle, ''), '^@+', ''));
begin
  if coalesce(p_key, '') = '' or p_handoff is null or p_track is null or handle = '' then
    return jsonb_build_object('ok', false, 'code', 'bad_request');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ig-curator-send', 0));

  select * into existing from public.agh_ig_dm_send_log where claim_key = p_key;
  if found then
    return jsonb_build_object('ok', false, 'code', 'duplicate', 'status', existing.status);
  end if;

  if exists (
    select 1
      from public.agh_handoff_records r
      join public.playlist_targets p on p.playlist_id = r.playlist_target_id
     where r.track_id = p_track
       and r.submitted_at is not null
       and r.submission_channel = 'instagram_dm'
       and lower(regexp_replace(coalesce(p.ig_curator_account, p.curator_instagram, ''), '^@+', '')) = handle
  ) then
    return jsonb_build_object('ok', false, 'code', 'already_receipted');
  end if;

  select count(*) into used
    from public.agh_ig_dm_send_log
   where status in ('claimed', 'sent')
     and claimed_at >= p_day_start;
  if used >= greatest(coalesce(p_cap, 0), 0) then
    return jsonb_build_object('ok', false, 'code', 'cap');
  end if;

  insert into public.agh_ig_dm_send_log (claim_key, handoff_record_id, track_id, ig_handle, status)
  values (p_key, p_handoff, p_track, handle, 'claimed');
  return jsonb_build_object('ok', true, 'code', 'claimed');
end $$;

comment on function public.agh_claim_ig_curator_send(text, uuid, uuid, text, int, timestamptz) is
  'Claim one Instagram curator DM for a song and handle. Holds a lock so two schedulers cannot both send. Does not send.';
