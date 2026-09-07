-- Final operational amendment: harden advance_agh_handoff_batch (service_role only,
-- legal transition graph, stamp discipline) + correct Grok upstream queue states.
-- Apply via Lovable SQL Editor AFTER 20260907000000..20260907020000.
-- Do NOT apply until PR review authorizes production deploy.

begin;

-- ---------------------------------------------------------------------------
-- 1. Replace RPC: validate transition graph; stamp only for legal next state;
--    never overwrite existing approval/review attribution; never touch discovered_by.
-- ---------------------------------------------------------------------------
create or replace function public.advance_agh_handoff_batch(
  p_batch_id uuid,
  p_expected_state text,
  p_next_state text,
  p_stamps jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch public.agh_handoff_batches%rowtype;
  v_updated int;
  v_legal boolean := false;
  v_stamps jsonb := coalesce(p_stamps, '{}'::jsonb);
begin
  if p_batch_id is null or p_expected_state is null or p_next_state is null then
    return jsonb_build_object('ok', false, 'code', 'bad_request', 'error', 'batch_id and states required');
  end if;

  -- Legal single-step playlist chain (no shortcuts). Same-state is not an advance.
  if p_expected_state = 'CLAUDE_BATCH_READY' and p_next_state = 'CLAUDE_PLAYLIST_COMPLETE' then
    v_legal := true;
  elsif p_expected_state = 'CLAUDE_PLAYLIST_COMPLETE' and p_next_state = 'AWAITING_GROK_REVIEW' then
    v_legal := true;
  elsif p_expected_state = 'AWAITING_GROK_REVIEW' and p_next_state = 'GROK_REVIEWED' then
    v_legal := true;
  elsif p_expected_state = 'GROK_REVIEWED' and p_next_state in ('APPROVED_FOR_SEND', 'REJECTED_BY_GROK') then
    v_legal := true;
  elsif p_expected_state = 'APPROVED_FOR_SEND' and p_next_state = 'AWAITING_AGH_IMPORT' then
    v_legal := true;
  elsif p_expected_state = 'AWAITING_AGH_IMPORT' and p_next_state = 'IMPORTED_TO_AGH' then
    v_legal := true;
  end if;

  if not v_legal then
    return jsonb_build_object(
      'ok', false,
      'code', 'illegal_transition',
      'error', format('Illegal handoff transition %s → %s', p_expected_state, p_next_state),
      'expected', p_expected_state,
      'attempted', p_next_state
    );
  end if;

  update public.agh_handoff_batches b
     set queue_state = p_next_state,
         updated_at = now(),
         -- Draft stamps only on Claude completion / handoff-to-Grok steps; never overwrite set values.
         drafted_by = case
           when p_next_state in ('CLAUDE_PLAYLIST_COMPLETE', 'AWAITING_GROK_REVIEW')
             then coalesce(b.drafted_by, nullif(v_stamps->>'drafted_by', ''))
           else b.drafted_by
         end,
         drafted_by_label = case
           when p_next_state in ('CLAUDE_PLAYLIST_COMPLETE', 'AWAITING_GROK_REVIEW')
             then coalesce(b.drafted_by_label, nullif(v_stamps->>'drafted_by_label', ''))
           else b.drafted_by_label
         end,
         -- Review stamps only when entering GROK_REVIEWED; never overwrite.
         reviewed_by = case
           when p_next_state = 'GROK_REVIEWED'
             then coalesce(b.reviewed_by, nullif(v_stamps->>'reviewed_by', ''))
           else b.reviewed_by
         end,
         reviewed_by_label = case
           when p_next_state = 'GROK_REVIEWED'
             then coalesce(b.reviewed_by_label, nullif(v_stamps->>'reviewed_by_label', ''))
           else b.reviewed_by_label
         end,
         -- Approval stamps only on APPROVED_FOR_SEND; never overwrite.
         approved_by = case
           when p_next_state = 'APPROVED_FOR_SEND'
             then coalesce(b.approved_by, nullif(v_stamps->>'approved_by', ''))
           else b.approved_by
         end,
         approved_by_label = case
           when p_next_state = 'APPROVED_FOR_SEND'
             then coalesce(b.approved_by_label, nullif(v_stamps->>'approved_by_label', ''))
           else b.approved_by_label
         end,
         -- Reject stamps only on REJECTED_BY_GROK; never overwrite.
         rejected_by = case
           when p_next_state = 'REJECTED_BY_GROK'
             then coalesce(b.rejected_by, nullif(v_stamps->>'rejected_by', ''))
           else b.rejected_by
         end,
         rejected_by_label = case
           when p_next_state = 'REJECTED_BY_GROK'
             then coalesce(b.rejected_by_label, nullif(v_stamps->>'rejected_by_label', ''))
           else b.rejected_by_label
         end,
         notes = case
           when p_next_state = 'REJECTED_BY_GROK' and nullif(v_stamps->>'notes', '') is not null
             then coalesce(b.notes, v_stamps->>'notes')
           else b.notes
         end
   where b.id = p_batch_id
     and b.queue_state = p_expected_state
  returning * into v_batch;

  if not found then
    return jsonb_build_object(
      'ok', false,
      'code', 'conflict',
      'error', 'queue_state changed by another request or batch missing',
      'expected', p_expected_state,
      'attempted', p_next_state
    );
  end if;

  update public.agh_handoff_records r
     set queue_state = p_next_state,
         updated_at = now(),
         reviewed_by = case
           when p_next_state = 'GROK_REVIEWED'
             then coalesce(r.reviewed_by, nullif(v_stamps->>'reviewed_by', ''))
           else r.reviewed_by
         end,
         reviewed_by_label = case
           when p_next_state = 'GROK_REVIEWED'
             then coalesce(r.reviewed_by_label, nullif(v_stamps->>'reviewed_by_label', ''))
           else r.reviewed_by_label
         end,
         approved_by = case
           when p_next_state = 'APPROVED_FOR_SEND'
             then coalesce(r.approved_by, nullif(v_stamps->>'approved_by', ''))
           else r.approved_by
         end,
         approved_by_label = case
           when p_next_state = 'APPROVED_FOR_SEND'
             then coalesce(r.approved_by_label, nullif(v_stamps->>'approved_by_label', ''))
           else r.approved_by_label
         end,
         rejected_by = case
           when p_next_state = 'REJECTED_BY_GROK'
             then coalesce(r.rejected_by, nullif(v_stamps->>'rejected_by', ''))
           else r.rejected_by
         end,
         rejected_by_label = case
           when p_next_state = 'REJECTED_BY_GROK'
             then coalesce(r.rejected_by_label, nullif(v_stamps->>'rejected_by_label', ''))
           else r.rejected_by_label
         end
   where r.batch_id = p_batch_id;

  get diagnostics v_updated = row_count;

  return jsonb_build_object(
    'ok', true,
    'batch', to_jsonb(v_batch),
    'records_updated', v_updated
  );
end;
$$;

-- Close direct RPC authorization bypass: service_role only.
revoke all on function public.advance_agh_handoff_batch(uuid, text, text, jsonb) from public;
revoke all on function public.advance_agh_handoff_batch(uuid, text, text, jsonb) from anon;
revoke all on function public.advance_agh_handoff_batch(uuid, text, text, jsonb) from authenticated;
grant execute on function public.advance_agh_handoff_batch(uuid, text, text, jsonb) to service_role;

comment on function public.advance_agh_handoff_batch(uuid, text, text, jsonb) is
  'Atomic CAS handoff advance. SECURITY DEFINER; EXECUTE granted to service_role only. Validates legal transition graph and refuses stamp overwrite of approval/review attribution.';

-- ---------------------------------------------------------------------------
-- 2. Correct Grok station upstream queue requirements
--    Review requires AWAITING_GROK_REVIEW; send requires APPROVED_FOR_SEND.
-- ---------------------------------------------------------------------------
insert into public.ops_settings (setting_key, setting_value, description) values
  (
    'daily_stations',
    jsonb_build_object(
      'timezone', 'America/Chicago',
      'stations', jsonb_build_array(
        jsonb_build_object('id', 'playlist_discovery_begin', 'local_time', '04:30', 'owner', 'claude', 'label', 'Playlist discovery begins'),
        jsonb_build_object('id', 'playlist_tranche_first', 'local_time', '07:00', 'owner', 'claude', 'label', 'First playlist tranche ready'),
        jsonb_build_object('id', 'playlist_tranche_final', 'local_time', '08:30', 'owner', 'claude', 'label', 'Final playlist tranche + sync discovery', 'advances_batch_to', 'AWAITING_GROK_REVIEW'),
        jsonb_build_object('id', 'sync_batch_ready', 'local_time', '12:00', 'owner', 'claude', 'label', 'Sync batch ready'),
        jsonb_build_object('id', 'grok_playlist_review', 'local_time', '13:00', 'owner', 'grok_playlist_control', 'label', 'Grok playlist review', 'requires_upstream_queue_state', 'AWAITING_GROK_REVIEW'),
        jsonb_build_object('id', 'grok_playlist_send', 'local_time', '15:00', 'owner', 'grok_playlist_control', 'label', 'Grok approved send', 'requires_upstream_queue_state', 'APPROVED_FOR_SEND')
      ),
      'scheduler_note', 'OUTREACH_SCHEDULER_SECRET may start Claude stations only; completion requires Claude credential. Grok stations require GROK_PLAYLIST_CONTROL_SECRET or Fendi. Grok review hard-requires AWAITING_GROK_REVIEW; send hard-requires APPROVED_FOR_SEND.'
    ),
    'Claude + Grok station schedule — America/Chicago. Grok cannot front-run AWAITING_GROK_REVIEW / APPROVED_FOR_SEND.'
  )
on conflict (setting_key) do update
  set setting_value = excluded.setting_value,
      description = excluded.description,
      updated_at = now();

commit;