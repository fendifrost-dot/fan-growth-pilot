-- ---------------------------------------------------------------------------
-- Submission-route correctness + honest discovery yield.
-- Apply via Lovable SQL Editor (paste). Idempotent: create-or-replace / if-not-exists.
-- Defines functions only — it does NOT hold any record by itself. The audit is run
-- explicitly afterwards (preview first):
--     select public.agh_route_hold_audit(false);   -- preview, no writes
--     select public.agh_route_hold_audit(true);    -- apply holds
--
-- Background (2026-09-27): discovery passed the playlist's own Spotify URL as the
-- submission URL whenever no form was supplied, and the verifier accepted any http URL +
-- any evidence as a web form. Result: packets with null routes (or a Spotify playlist
-- URL as form_url) marked auto_verified / path_verified=true. Rules below mirror
-- supabase/functions/_shared/submission-route.ts exactly.
-- ---------------------------------------------------------------------------

begin;

-- ---------------------------------------------------------------------------
-- 1. Route rule (SQL mirror of assessSubmissionRoute / assertSubmissionReady).
--    Returns NULL when the route is submission-ready, else a failure code.
-- ---------------------------------------------------------------------------
create or replace function public.agh_route_failure_code(
  p_channel text,
  p_verification_status text,
  p_path_verified boolean,
  p_curator_email text,
  p_form_url text,
  p_submission_url text,
  p_form_evidence text,
  p_ig_account text,
  p_ig_evidence text
) returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  v_channel text := lower(nullif(trim(coalesce(p_channel, '')), ''));
  v_status text := lower(coalesce(trim(p_verification_status), ''));
  v_form text := coalesce(nullif(trim(p_form_url), ''), nullif(trim(p_submission_url), ''));
  v_host text;
  v_ev text;
  v_negation text :=
    '(\yno (submission )?(route|path|form|contact|email)s? (was |were )?(confirmed|found|available|listed|located|identified)\y)'
    || '|(\yno submission (route|path|form|option|method)\y)'
    || '|(\y(route|form|submission|contact) (is |was )?(not |un)(confirmed|verified|found|available)\y)'
    || '|(\ynot accepting submissions\y)'
    || '|(\ysubmissions? (are |is )?closed\y)'
    || '|(\yno (public )?(way|means) to submit\y)';
begin
  if v_channel is null or v_channel not in ('email', 'web_form', 'instagram_dm') then
    return 'no_route_channel';
  end if;
  if v_status not in ('auto_verified', 'manually_verified') then
    return 'route_not_verified';
  end if;
  if v_channel <> 'email' and coalesce(p_path_verified, false) is not true then
    return 'route_not_verified';
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
    v_ev := nullif(trim(coalesce(p_form_evidence, '')), '');
    if v_ev is null then
      return 'missing_form_evidence';
    end if;
    if v_ev ~* v_negation then
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
  v_ev := nullif(trim(coalesce(p_ig_evidence, '')), '');
  if v_ev is null then
    return 'missing_ig_evidence';
  end if;
  if v_ev ~* v_negation then
    return 'evidence_negates_route';
  end if;
  return null;
end;
$$;

comment on function public.agh_route_failure_code(text, text, boolean, text, text, text, text, text, text) is
  'SQL mirror of submission-route.ts: NULL when the route is submission-ready, else a failure code.';

-- ---------------------------------------------------------------------------
-- 2. Hold records whose route fails: move each into a Claude-side repair batch
--    (CLAUDE_BATCH_READY) so valid records in the original batch keep moving and
--    Grok never approves an unusable route. Never touches submitted / sent / rejected /
--    imported records. Audit trail: packet.route_hold (+ history), batch notes/payload.
-- ---------------------------------------------------------------------------
create or replace function public.agh_route_hold_records(
  p_items jsonb,           -- [{ "record_id": uuid, "code": text, "reason": text }]
  p_held_by text default 'system_route_audit'
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item jsonb;
  v_rec public.agh_handoff_records%rowtype;
  v_src public.agh_handoff_batches%rowtype;
  v_repair uuid;
  v_held jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_touched uuid[] := '{}';
  v_bid uuid;
  v_draft_status text;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    return jsonb_build_object('ok', false, 'code', 'bad_request', 'error', 'items array required');
  end if;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    select * into v_rec from public.agh_handoff_records
     where id = (v_item->>'record_id')::uuid
     for update;
    if not found then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('record_id', v_item->>'record_id', 'reason', 'not_found'));
      continue;
    end if;
    if v_rec.submitted_at is not null
       or v_rec.queue_state in ('REJECTED_BY_GROK', 'AWAITING_AGH_IMPORT', 'IMPORTED_TO_AGH') then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('record_id', v_rec.id, 'reason', 'terminal_or_submitted'));
      continue;
    end if;
    if v_rec.outreach_draft_id is not null then
      select status into v_draft_status from public.outreach_drafts where id = v_rec.outreach_draft_id;
      if v_draft_status in ('sent', 'sent_audit_broken') then
        v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('record_id', v_rec.id, 'reason', 'draft_already_sent'));
        continue;
      end if;
    end if;

    select * into v_src from public.agh_handoff_batches where id = v_rec.batch_id;

    -- Already sitting in a repair batch: refresh the reason only.
    if coalesce(v_src.payload->>'route_hold_repair', 'false') = 'true' then
      update public.agh_handoff_records
         set packet = packet || jsonb_build_object('route_hold', jsonb_build_object(
               'code', v_item->>'code', 'reason', v_item->>'reason',
               'held_at', now(), 'held_by', p_held_by,
               'prior_batch_id', coalesce(packet->'route_hold'->>'prior_batch_id', v_rec.batch_id::text),
               'prior_queue_state', coalesce(packet->'route_hold'->>'prior_queue_state', v_rec.queue_state))),
             updated_at = now()
       where id = v_rec.id;
      v_held := v_held || jsonb_build_array(jsonb_build_object('record_id', v_rec.id, 'repair_batch_id', v_rec.batch_id, 'refreshed', true));
      continue;
    end if;

    select id into v_repair from public.agh_handoff_batches
     where payload->>'route_hold_source_batch' = v_src.id::text
       and queue_state = 'CLAUDE_BATCH_READY'
     limit 1;
    if v_repair is null then
      insert into public.agh_handoff_batches (
        batch_kind, queue_state, track_id, song_dna_version_id,
        discovered_by, discovered_by_label, drafted_by, drafted_by_label,
        business_date_ct, notes, payload, record_count
      ) values (
        v_src.batch_kind, 'CLAUDE_BATCH_READY', v_src.track_id, v_src.song_dna_version_id,
        v_src.discovered_by, v_src.discovered_by_label, v_src.drafted_by, v_src.drafted_by_label,
        v_src.business_date_ct,
        format('ROUTE_HOLD repair batch — records moved from batch %s (was %s) because their submission route failed verification.', v_src.id, v_src.queue_state),
        jsonb_build_object('route_hold_repair', true, 'route_hold_source_batch', v_src.id, 'source_queue_state', v_src.queue_state),
        0
      ) returning id into v_repair;
    end if;

    update public.agh_handoff_records
       set batch_id = v_repair,
           queue_state = 'CLAUDE_BATCH_READY',
           packet = packet || jsonb_build_object(
             'route_hold', jsonb_build_object(
               'code', v_item->>'code', 'reason', v_item->>'reason',
               'held_at', now(), 'held_by', p_held_by,
               'prior_batch_id', v_rec.batch_id, 'prior_queue_state', v_rec.queue_state,
               'prior_reviewed_by', v_rec.reviewed_by, 'prior_approved_by', v_rec.approved_by),
             'route_hold_history', coalesce(packet->'route_hold_history', '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
               'code', v_item->>'code', 'held_at', now(), 'from_batch', v_rec.batch_id, 'from_state', v_rec.queue_state))),
           updated_at = now()
     where id = v_rec.id;

    v_touched := v_touched || v_rec.batch_id || v_repair;
    v_held := v_held || jsonb_build_array(jsonb_build_object(
      'record_id', v_rec.id, 'from_batch_id', v_rec.batch_id, 'from_state', v_rec.queue_state,
      'repair_batch_id', v_repair, 'code', v_item->>'code'));
    v_repair := null;
  end loop;

  foreach v_bid in array v_touched
  loop
    update public.agh_handoff_batches b
       set record_count = (select count(*) from public.agh_handoff_records r where r.batch_id = b.id),
           updated_at = now()
     where b.id = v_bid;
  end loop;

  return jsonb_build_object('ok', true, 'held', v_held, 'held_count', jsonb_array_length(v_held),
                            'skipped', v_skipped);
end;
$$;

revoke all on function public.agh_route_hold_records(jsonb, text) from public, anon, authenticated;
grant execute on function public.agh_route_hold_records(jsonb, text) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Audit of unsent packets (preview by default). Also clears path_verified on the
--    failing targets, keeping the prior notes in path_verification_notes.
-- ---------------------------------------------------------------------------
create or replace function public.agh_route_hold_audit(p_apply boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_items jsonb;
  v_result jsonb := null;
  v_by_code jsonb;
  v_targets int := 0;
begin
  with candidates as (
    select r.id as record_id, r.batch_id, r.queue_state, r.playlist_target_id, r.submission_channel,
           public.agh_route_failure_code(
             coalesce(r.submission_channel, pt.contact_method, pt.submission_method),
             pt.verification_status, pt.path_verified, pt.curator_email, pt.form_url,
             pt.submission_url, pt.form_source_evidence,
             coalesce(pt.ig_curator_account, pt.curator_instagram), pt.ig_source_evidence
           ) as code
      from public.agh_handoff_records r
      join public.agh_handoff_batches b on b.id = r.batch_id and b.batch_kind = 'playlist'
      left join public.playlist_targets pt on pt.playlist_id = r.playlist_target_id
      left join public.outreach_drafts d on d.id = r.outreach_draft_id
     where r.record_kind = 'playlist_target'
       and r.submitted_at is null
       and r.queue_state in ('CLAUDE_BATCH_READY', 'CLAUDE_PLAYLIST_COMPLETE', 'AWAITING_GROK_REVIEW', 'GROK_REVIEWED', 'APPROVED_FOR_SEND')
       and coalesce(d.status, '') not in ('sent', 'sent_audit_broken')
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'record_id', record_id, 'code', code,
           'reason', 'submission route failed re-verification: ' || code,
           'batch_id', batch_id, 'queue_state', queue_state,
           'playlist_target_id', playlist_target_id, 'channel', submission_channel)), '[]'::jsonb)
    into v_items
    from candidates
   where code is not null;

  select coalesce(jsonb_object_agg(code, n), '{}'::jsonb) into v_by_code
    from (select i->>'code' as code, count(*) as n from jsonb_array_elements(v_items) i group by 1) s;

  if p_apply and jsonb_array_length(v_items) > 0 then
    v_result := public.agh_route_hold_records(v_items, 'route_audit_2026_09_27');

    update public.playlist_targets pt
       set path_verified = false,
           path_verification_notes = 'ROUTE_HOLD: ' || h.code || ' (audit 2026-09-27; prior: '
             || coalesce(pt.path_verification_notes, 'none') || ')',
           updated_at = now()
      from (select distinct i->>'playlist_target_id' as pid, i->>'code' as code
              from jsonb_array_elements(v_items) i
             where i->>'playlist_target_id' is not null) h
     where pt.playlist_id = h.pid
       and pt.path_verified is true
       and coalesce(pt.path_verification_notes, '') not like 'ROUTE_HOLD:%';
    get diagnostics v_targets = row_count;
  end if;

  return jsonb_build_object(
    'ok', true,
    'applied', p_apply,
    'failing_record_count', jsonb_array_length(v_items),
    'by_code', v_by_code,
    'records', v_items,
    'targets_marked', v_targets,
    'hold_result', v_result
  );
end;
$$;

revoke all on function public.agh_route_hold_audit(boolean) from public, anon, authenticated;
grant execute on function public.agh_route_hold_audit(boolean) to service_role;

-- ---------------------------------------------------------------------------
-- 4. Candidate evaluation log — the server-side denominator for raw→verified yield.
--    One row per (business date, song, candidate identity): retries collapse, and
--    cross-song reuse stays per-song. Written by submit_playlist_candidates.
-- ---------------------------------------------------------------------------
create table if not exists public.agh_playlist_candidate_evaluations (
  id uuid primary key default gen_random_uuid(),
  business_date_ct date not null,
  track_id uuid not null,
  identity_key text not null,
  playlist_target_id text,
  outcome text not null
    check (outcome in (
      'verified_eligible_new',      -- new target, route verified, fits song
      'verified_eligible_existing', -- existing target newly matched to this song
      'accepted_unverified',        -- stored but no verified route
      'duplicate',                  -- already drafted / pitched / cooldown for this song
      'rejected'                    -- failed identity / evidence / lane / DNA
    )),
  reason_code text,
  created_target boolean not null default false,
  attempts int not null default 1,
  discovered_by text not null default 'claude_playlist_discovery',
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create unique index if not exists agh_playlist_candidate_evaluations_day_uidx
  on public.agh_playlist_candidate_evaluations (business_date_ct, track_id, identity_key);
create index if not exists agh_playlist_candidate_evaluations_seen_idx
  on public.agh_playlist_candidate_evaluations (last_seen_at);

alter table public.agh_playlist_candidate_evaluations enable row level security;
drop policy if exists agh_playlist_candidate_evaluations_admin_all on public.agh_playlist_candidate_evaluations;
create policy agh_playlist_candidate_evaluations_admin_all on public.agh_playlist_candidate_evaluations
  for all to authenticated
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));

-- Upsert that keeps the BEST outcome seen for the identity that day (a retry that is
-- now a duplicate of the draft it created must not erase the eligible result).
create or replace function public.agh_log_candidate_evaluation(
  p_business_date date,
  p_track_id uuid,
  p_identity_key text,
  p_playlist_target_id text,
  p_outcome text,
  p_reason_code text,
  p_created_target boolean
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.agh_playlist_candidate_evaluations as e (
    business_date_ct, track_id, identity_key, playlist_target_id, outcome, reason_code, created_target
  ) values (
    p_business_date, p_track_id, p_identity_key, p_playlist_target_id, p_outcome, p_reason_code,
    coalesce(p_created_target, false)
  )
  on conflict (business_date_ct, track_id, identity_key) do update
     set attempts = e.attempts + 1,
         last_seen_at = now(),
         playlist_target_id = coalesce(e.playlist_target_id, excluded.playlist_target_id),
         created_target = e.created_target or excluded.created_target,
         outcome = case
           when e.outcome in ('verified_eligible_new', 'verified_eligible_existing') then e.outcome
           else excluded.outcome
         end,
         reason_code = case
           when e.outcome in ('verified_eligible_new', 'verified_eligible_existing') then e.reason_code
           else excluded.reason_code
         end;
end;
$$;

revoke all on function public.agh_log_candidate_evaluation(date, uuid, text, text, text, text, boolean) from public, anon, authenticated;
grant execute on function public.agh_log_candidate_evaluation(date, uuid, text, text, text, text, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Spotify key-alias report (READ-ONLY). `spotify:<id>` is a legitimate stored key
--    form (placements, pitch_log), so rows are NOT renamed: lookups now resolve all
--    forms. This reports how many rows use a prefixed form and any collisions where the
--    same playlist is stored under two keys (resolve those with the existing dedupe
--    process — never merged automatically).
-- ---------------------------------------------------------------------------
create or replace function public.agh_spotify_key_alias_report()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with keyed as (
    select playlist_id,
           verification_status,
           case
             when playlist_id ~ '^[A-Za-z0-9]{22}$' then playlist_id
             when playlist_id ~ '^spotify:[A-Za-z0-9]{22}$' then substring(playlist_id from 9)
             when playlist_id ~ '^spotify:playlist:[A-Za-z0-9]{22}$' then substring(playlist_id from 18)
             else null
           end as canonical
      from public.playlist_targets
  ),
  groups as (
    select canonical, array_agg(playlist_id order by playlist_id) as keys, count(*) as n
      from keyed where canonical is not null group by canonical
  )
  select jsonb_build_object(
    'prefixed_rows', (select count(*) from keyed where canonical is not null and playlist_id <> canonical),
    'prefixed_manually_verified', (select count(*) from keyed where canonical is not null and playlist_id <> canonical and verification_status = 'manually_verified'),
    'collision_count', (select count(*) from groups where n > 1),
    'collisions', coalesce((select jsonb_agg(jsonb_build_object('canonical', canonical, 'keys', keys)) from groups where n > 1), '[]'::jsonb)
  );
$$;

revoke all on function public.agh_spotify_key_alias_report() from public, anon, authenticated;
grant execute on function public.agh_spotify_key_alias_report() to service_role;

commit;
