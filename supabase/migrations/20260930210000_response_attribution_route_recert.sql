-- ---------------------------------------------------------------------------
-- 2026-09-30 follow-up to 20260930190000_pipeline_repair.sql (forward-only).
--
-- 1. agh_update_pitch_response(p_id, p_patch, p_actor): the single write path for curator
--    response fields on pitch_log. It sets agh.response_actor for the transaction, so the
--    existing agh_preserve_pitch_response trigger records the REAL caller in
--    agh_pitch_response_events instead of 'unattributed:<db user>' (every edge function
--    shares one service role). Only response fields are writable; the trigger's
--    append/protect rules are unchanged.
-- 2. agh_route_recertify_targets(p_apply): targets still flagged path_verified=true
--    whose stored route fails the shared rule (agh_route_failure_code) — flags set by the
--    pre-2026-09-27 verifier. Preview by default; apply sets path_verified=false with a
--    ROUTE_RECERT note that keeps the prior note. Records are not moved, nothing is
--    sent, verification_status is not changed.
-- ---------------------------------------------------------------------------
begin;

create or replace function public.agh_update_pitch_response(
  p_id uuid,
  p_patch jsonb,
  p_actor text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_allowed text[] := array['reply_received', 'placed', 'placement_status', 'response_notes', 'follow_up_at'];
  v_bad text;
  v_row public.pitch_log%rowtype;
begin
  if p_id is null or p_patch is null or jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'::jsonb then
    return jsonb_build_object('ok', false, 'code', 'bad_request', 'error', 'id and a non-empty patch object required');
  end if;
  if nullif(trim(coalesce(p_actor, '')), '') is null then
    return jsonb_build_object('ok', false, 'code', 'actor_required', 'error', 'actor required for attribution');
  end if;
  select k into v_bad from jsonb_object_keys(p_patch) k where k <> all(v_allowed) limit 1;
  if v_bad is not null then
    return jsonb_build_object('ok', false, 'code', 'field_not_allowed', 'error', format('field %s is not a response field', v_bad));
  end if;

  -- Transaction-local: read by agh_preserve_pitch_response for the audit row.
  perform set_config('agh.response_actor', left(trim(p_actor), 120), true);

  update public.pitch_log l
     set reply_received   = case when p_patch ? 'reply_received' then (p_patch->>'reply_received')::boolean else l.reply_received end,
         placed           = case when p_patch ? 'placed' then (p_patch->>'placed')::boolean else l.placed end,
         placement_status = case when p_patch ? 'placement_status' then nullif(trim(p_patch->>'placement_status'), '') else l.placement_status end,
         response_notes   = case when p_patch ? 'response_notes' then nullif(trim(p_patch->>'response_notes'), '') else l.response_notes end,
         follow_up_at     = case when p_patch ? 'follow_up_at' then (p_patch->>'follow_up_at')::timestamptz else l.follow_up_at end
   where l.id = p_id
  returning * into v_row;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'not_found', 'error', 'pitch_log row not found');
  end if;
  return jsonb_build_object('ok', true, 'row', to_jsonb(v_row), 'actor', left(trim(p_actor), 120));
end;
$$;

revoke all on function public.agh_update_pitch_response(uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.agh_update_pitch_response(uuid, jsonb, text) to service_role;

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
             t.ig_curator_account, t.ig_source_evidence, t.research_context->>'source_url', t.is_active) as code,
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

commit;
