-- Server-side route fetch: a stored server_fetch pass is route proof.
-- Apply via Lovable SQL Editor (paste). Idempotent.
--
-- Expected result: functions replaced, one ops_settings row inserted
-- (route_fetch_firecrawl_fallback enabled=false, daily_cap=25),
-- and 0 playlist_targets rows changed. Replaced functions still contain
-- their existing apply-time updates, but this migration never calls them.
--
-- agh_route_failure_code gains p_route_method (default null). Existing
-- 9–11 argument callers, including agh_fit_rejection_requeue, keep working.
-- When the method is server_fetch, evidence-text checks are skipped after
-- the URL / handle structural checks. Spotify and other platform URLs still fail.

begin;

drop function if exists public.agh_route_failure_code(text, text, boolean, text, text, text, text, text, text, text, boolean);
drop function if exists public.agh_route_failure_code(text, text, boolean, text, text, text, text, text, text, text, boolean, text);

create or replace function public.agh_route_failure_code(
  p_channel text,
  p_verification_status text,
  p_path_verified boolean,
  p_curator_email text,
  p_form_url text,
  p_submission_url text,
  p_form_evidence text,
  p_ig_account text,
  p_ig_evidence text,
  p_source_url text default null,
  p_is_active boolean default null,
  p_route_method text default null
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
    -- URL shape above still applies. A server_fetch pass already loaded the page,
    -- so agent evidence text is not re-checked.
    if lower(trim(coalesce(p_route_method, ''))) = 'server_fetch' then
      return null;
    end if;
    v_ev := nullif(trim(coalesce(p_form_evidence, '')), '');
    if v_ev is null then
      return 'missing_form_evidence';
    end if;
    if v_ev ~* v_negation then
      return 'evidence_negates_route';
    end if;
    -- Evidence (or the listing page) must name the form's site; hosted form builders
    -- identify a specific form by URL.
    if v_host in ('docs.google.com', 'forms.gle', 'typeform.com', 'jotform.com', 'tally.so', 'airtable.com',
                  'forms.office.com', 'formstack.com', 'wufoo.com')
       or v_host like '%.typeform.com' or v_host like '%.jotform.com' then
      return null;
    end if;
    v_label := regexp_replace(coalesce(
      substring(v_host from '([^.]+)\.(co|com|org|net|ac|gov)\.[a-z]{2}$'),
      substring(v_host from '([^.]+)\.[^.]+$'),
      v_host), '[^a-z0-9]', '', 'g');
    if length(v_label) >= 3
       and position(v_label in regexp_replace(lower(v_ev), '[^a-z0-9]', '', 'g')) = 0 then
      v_src_label := regexp_replace(coalesce(
        substring(regexp_replace(lower(substring(coalesce(p_source_url, '') from '^[A-Za-z]+://([^/:?#]+)')), '^www\.', '')
                  from '([^.]+)\.[^.]+$'), ''), '[^a-z0-9]', '', 'g');
      if v_src_label is distinct from v_label then
        return 'evidence_not_linked_to_form';
      end if;
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
  if v_ev is null then
    return 'missing_ig_evidence';
  end if;
  if v_ev ~* v_negation then
    return 'evidence_negates_route';
  end if;
  return null;
end;
$$;

comment on function public.agh_route_failure_code(text, text, boolean, text, text, text, text, text, text, text, boolean, text) is
  'SQL mirror of submission-route.ts. NULL when the route is submission-ready. p_route_method server_fetch skips evidence-text checks after URL and handle shape checks.';

grant execute on function public.agh_route_failure_code(text, text, boolean, text, text, text, text, text, text, text, boolean, text) to service_role;

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
             coalesce(pt.ig_curator_account, pt.curator_instagram), pt.ig_source_evidence,
             pt.research_context->>'source_url', pt.is_active,
             nullif(pt.research_context #>> '{route_fetch,method}', '')
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

create or replace function public.agh_route_recertify_targets(p_apply boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_items jsonb;
  v_by_code jsonb;
  v_updated int := 0;
begin
  with f as (
    select t.playlist_id,
           public.agh_route_failure_code(coalesce(nullif(t.contact_method, ''), t.submission_method), t.verification_status,
             t.path_verified, t.curator_email, t.form_url, t.submission_url, t.form_source_evidence,
             t.ig_curator_account, t.ig_source_evidence, t.research_context->>'source_url', t.is_active,
             nullif(t.research_context #>> '{route_fetch,method}', '')) as code,
           exists (select 1 from public.agh_handoff_records r
                    where r.playlist_target_id = t.playlist_id and r.submitted_at is null
                      and r.queue_state in ('CLAUDE_BATCH_READY','CLAUDE_PLAYLIST_COMPLETE','AWAITING_GROK_REVIEW','GROK_REVIEWED','APPROVED_FOR_SEND')) as open_packets
      from public.playlist_targets t
     where t.path_verified is true
  )
  select coalesce(jsonb_agg(jsonb_build_object('playlist_id', playlist_id, 'code', code, 'open_packets', open_packets)
                            order by code, playlist_id), '[]'::jsonb)
    into v_items
    from f where code is not null;

  select coalesce(jsonb_object_agg(code, n), '{}'::jsonb) into v_by_code
    from (select i->>'code' as code, count(*) n from jsonb_array_elements(v_items) i group by 1) s;

  if p_apply then
    perform pg_advisory_xact_lock(hashtextextended('agh_route_recertify_targets', 0));
    update public.playlist_targets t
       set path_verified = false,
           path_verification_notes = 'ROUTE_RECERT: ' || (i->>'code') || ' (2026-09-30 re-check against current route rules; prior: '
                                     || coalesce(t.path_verification_notes, 'none') || ')',
           updated_at = now()
      from jsonb_array_elements(v_items) i
     where t.playlist_id = i->>'playlist_id'
       and t.path_verified is true;
    get diagnostics v_updated = row_count;
  end if;

  return jsonb_build_object(
    'ok', true,
    'applied', p_apply,
    'failing_targets', jsonb_array_length(v_items),
    'with_open_packets', (select count(*) from jsonb_array_elements(v_items) i where (i->>'open_packets')::boolean),
    'by_code', v_by_code,
    'targets_updated', v_updated,
    'targets', v_items);
end;
$$;

revoke all on function public.agh_route_recertify_targets(boolean) from public, anon, authenticated;
grant execute on function public.agh_route_recertify_targets(boolean) to service_role;

create or replace function public.agh_promote_claude_ready_batches(
  p_dry_run boolean default true,
  p_business_date date default null,
  p_batch_ids uuid[] default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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
        v_stale := v_rec.packet ? 'route_hold'
          or v_fail is not null
          or v_target.last_verified_at is null
          or v_target.last_verified_at < now() - interval '7 days';
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
        'reason', 'Route failed current verification or is older than 7 days; held for re-verification instead of promotion'
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
    'note', 'Stale routes are re-verified, not promoted. Promotion stops at AWAITING_GROK_REVIEW.'
  );
end;
$$;


revoke all on function public.agh_promote_claude_ready_batches(boolean, date, uuid[]) from public, anon, authenticated;
grant execute on function public.agh_promote_claude_ready_batches(boolean, date, uuid[]) to service_role;

insert into public.ops_settings (setting_key, setting_value, description)
values (
  'route_fetch_firecrawl_fallback',
  jsonb_build_object('enabled', false, 'daily_cap', 25),
  'JS render fallback for submission-route fetch. Off by default. daily_cap is the maximum Firecrawl renders per UTC day. A plain fetch that only sees a JS shell stays accepted_unverified / js_render_required while this is off.'
)
on conflict (setting_key) do nothing;

commit;