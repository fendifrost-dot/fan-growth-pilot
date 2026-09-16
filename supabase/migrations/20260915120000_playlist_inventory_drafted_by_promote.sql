-- Persist drafted_by on playlist inventory batches + copy draft stamps onto
-- records during Claude → Grok promotion. Apply via Lovable SQL Editor (paste).
-- Idempotent: create or replace only. Does not rewrite existing rows.
--
-- Backfill for stranded CLAUDE_BATCH_READY rows is documented in the PR body
-- and is NOT applied by this file.

begin;

-- ---------------------------------------------------------------------------
-- 1. Persist RPC: stamp drafted_by on the batch (was discovered_by only)
--    and honor explicit p_attr drafted_by with discovered_by fallback.
-- ---------------------------------------------------------------------------
create or replace function public.agh_mcp_persist_playlist_inventory(
  p_track_id uuid,
  p_song_dna_version_id uuid,
  p_attr jsonb,
  p_items jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item jsonb;
  v_batch_id uuid;
  v_existing_batch uuid;
  v_all_existing boolean := true;
  v_results jsonb := '[]'::jsonb;
  v_email_drafts jsonb := '[]'::jsonb;
  v_manual jsonb := '[]'::jsonb;
  v_key text;
  v_channel text;
  v_playlist text;
  v_draft_id uuid;
  v_rec_id uuid;
  v_look jsonb;
  v_count int;
  v_packet jsonb;
  v_draft jsonb;
  v_discovered_by text;
  v_discovered_label text;
  v_drafted_by text;
  v_drafted_label text;
  v_retry jsonb;
  v_race_all boolean;
begin
  if p_track_id is null or p_song_dna_version_id is null then
    return jsonb_build_object('ok', false, 'code', 'bad_request', 'error', 'track and dna required');
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) < 1 then
    return jsonb_build_object('ok', false, 'code', 'bad_request', 'error', 'items required');
  end if;

  v_discovered_by := coalesce(nullif(p_attr->>'discovered_by', ''), 'claude_playlist_discovery');
  v_discovered_label := coalesce(nullif(p_attr->>'discovered_by_label', ''), v_discovered_by);
  -- Draft attribution is required for Playlist Control to treat inventory as
  -- handed to Grok. Never leave drafted_by NULL on a newly persisted batch.
  v_drafted_by := coalesce(nullif(p_attr->>'drafted_by', ''), v_discovered_by);
  v_drafted_label := coalesce(nullif(p_attr->>'drafted_by_label', ''), v_discovered_label);

  -- Idempotent short-circuit: if every item already has an open pair, return them.
  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_playlist := v_item->>'playlist_id';
    v_channel := v_item->>'channel';
    v_key := coalesce(
      v_item->>'idempotency_key',
      p_track_id::text || ':' || v_playlist || ':' || v_channel || ':' || p_song_dna_version_id::text
    );
    v_look := public.agh_mcp_lookup_inventory_pair(p_track_id, v_playlist, v_channel, p_song_dna_version_id);
    if coalesce((v_look->>'found')::boolean, false) then
      v_results := v_results || jsonb_build_array(v_look || jsonb_build_object('playlist_id', v_playlist, 'channel', v_channel, 'reused', true));
      if v_look->>'batch_id' is not null then
        v_existing_batch := (v_look->>'batch_id')::uuid;
      end if;
    else
      v_all_existing := false;
    end if;
  end loop;

  if v_all_existing then
    return jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'batch_id', v_existing_batch,
      'items', v_results,
      'inserted', 0
    );
  end if;

  -- Partial reuse is not supported in one call — caller must pass only new IDs
  -- or only existing IDs. Mixing would leave ambiguous batch ownership.
  if jsonb_array_length(v_results) > 0 and not v_all_existing then
    return jsonb_build_object(
      'ok', false,
      'code', 'mixed_idempotent_set',
      'error', 'request mixes existing and new inventory pairs — split the call',
      'existing', v_results
    );
  end if;

  insert into public.agh_handoff_batches (
    batch_kind, queue_state, track_id, song_dna_version_id,
    discovered_by, discovered_by_label, drafted_by, drafted_by_label,
    business_date_ct, record_count
  ) values (
    'playlist', 'CLAUDE_BATCH_READY', p_track_id, p_song_dna_version_id,
    v_discovered_by, v_discovered_label, v_drafted_by, v_drafted_label,
    (timezone('America/Chicago', now()))::date, 0
  ) returning id into v_batch_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_playlist := v_item->>'playlist_id';
    v_channel := v_item->>'channel';
    v_key := coalesce(
      v_item->>'idempotency_key',
      p_track_id::text || ':' || v_playlist || ':' || v_channel || ':' || p_song_dna_version_id::text
    );
    v_packet := coalesce(v_item->'packet', '{}'::jsonb);
    v_draft := v_item->'draft';
    v_draft_id := null;

    -- Claim / create draft for email channel
    if v_channel = 'email' then
      select id into v_draft_id
        from public.outreach_drafts
       where ops_idempotency_key = v_key
         and status in ('pending', 'approved')
       limit 1
       for update;

      if v_draft_id is null then
        if v_draft is null or v_draft->>'body' is null then
          raise exception 'email draft body required for %', v_playlist
            using errcode = 'check_violation';
        end if;
        insert into public.outreach_drafts (
          playlist_id, track_id, track_name, song_dna_version_id, channel,
          recipient, subject, body, generated_by, status,
          pitch_copy_source, pitch_copy_hash, ops_idempotency_key, metadata
        ) values (
          v_playlist,
          p_track_id,
          coalesce(v_draft->>'track_name', 'unknown'),
          p_song_dna_version_id,
          'email',
          v_draft->>'recipient',
          v_draft->>'subject',
          v_draft->>'body',
          coalesce(v_draft->>'generated_by', v_discovered_by),
          'pending',
          v_draft->>'pitch_copy_source',
          v_draft->>'pitch_copy_hash',
          v_key,
          coalesce(v_draft->'metadata', '{}'::jsonb)
        )
        returning id into v_draft_id;
      end if;

      v_email_drafts := v_email_drafts || jsonb_build_array(jsonb_build_object(
        'playlist_id', v_playlist,
        'outreach_draft_id', v_draft_id,
        'idempotency_key', v_key
      ));
    else
      v_manual := v_manual || jsonb_build_array(jsonb_build_object(
        'playlist_id', v_playlist,
        'channel', v_channel,
        'idempotency_key', v_key
      ));
    end if;

    insert into public.agh_handoff_records (
      batch_id, record_kind, queue_state, track_id, playlist_target_id,
      outreach_draft_id, submission_channel, dedupe_key, song_dna_version_id,
      packet, discovered_by, discovered_by_label, drafted_by, drafted_by_label
    ) values (
      v_batch_id,
      coalesce(v_item->>'record_kind', 'playlist_target'),
      coalesce(v_item->>'queue_state', 'CLAUDE_BATCH_READY'),
      p_track_id,
      v_playlist,
      v_draft_id,
      v_channel,
      v_key,
      p_song_dna_version_id,
      v_packet,
      v_discovered_by,
      v_discovered_label,
      v_drafted_by,
      v_drafted_label
    ) returning id into v_rec_id;

    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'playlist_id', v_playlist,
      'channel', v_channel,
      'idempotency_key', v_key,
      'outreach_draft_id', v_draft_id,
      'handoff_record_id', v_rec_id,
      'batch_id', v_batch_id,
      'reused', false
    ));
  end loop;

  select count(*)::int into v_count
    from public.agh_handoff_records where batch_id = v_batch_id;

  update public.agh_handoff_batches
     set record_count = v_count, updated_at = now()
   where id = v_batch_id;

  if v_count <> jsonb_array_length(p_items) then
    raise exception 'record_count mismatch after persist'
      using errcode = 'check_violation';
  end if;

  return jsonb_build_object(
    'ok', true,
    'idempotent', false,
    'batch_id', v_batch_id,
    'inserted', v_count,
    'record_count', v_count,
    'items', v_results,
    'email_drafts', v_email_drafts,
    'manual_packets', v_manual
  );
exception
  when unique_violation then
    v_retry := '[]'::jsonb;
    v_race_all := true;
    v_existing_batch := null;
    for v_item in select * from jsonb_array_elements(p_items)
    loop
      v_playlist := v_item->>'playlist_id';
      v_channel := v_item->>'channel';
      v_look := public.agh_mcp_lookup_inventory_pair(
        p_track_id, v_playlist, v_channel, p_song_dna_version_id
      );
      if coalesce((v_look->>'found')::boolean, false) then
        v_retry := v_retry || jsonb_build_array(
          v_look || jsonb_build_object('playlist_id', v_playlist, 'channel', v_channel, 'reused', true)
        );
        if v_look->>'batch_id' is not null then
          v_existing_batch := (v_look->>'batch_id')::uuid;
        end if;
      else
        v_race_all := false;
      end if;
    end loop;
    if v_race_all then
      return jsonb_build_object(
        'ok', true,
        'idempotent', true,
        'batch_id', v_existing_batch,
        'items', v_retry,
        'inserted', 0,
        'race_resolved', true
      );
    end if;
    return jsonb_build_object(
      'ok', false,
      'code', 'conflict',
      'error', SQLERRM
    );
end;
$$;

revoke all on function public.agh_mcp_persist_playlist_inventory(uuid, uuid, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.agh_mcp_persist_playlist_inventory(uuid, uuid, jsonb, jsonb)
  to service_role;

comment on function public.agh_mcp_persist_playlist_inventory is
  'Single-transaction inventory persist: batch + drafts + handoff records. Stamps drafted_by on the batch and records so Playlist Control can promote to AWAITING_GROK_REVIEW.';

-- ---------------------------------------------------------------------------
-- 2. Advance RPC: copy drafted_by onto records on Claude→Grok steps.
--    Previously only the batch received draft stamps.
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
         drafted_by = case
           when p_next_state in ('CLAUDE_PLAYLIST_COMPLETE', 'AWAITING_GROK_REVIEW')
             then coalesce(r.drafted_by, nullif(v_stamps->>'drafted_by', ''), v_batch.drafted_by)
           else r.drafted_by
         end,
         drafted_by_label = case
           when p_next_state in ('CLAUDE_PLAYLIST_COMPLETE', 'AWAITING_GROK_REVIEW')
             then coalesce(r.drafted_by_label, nullif(v_stamps->>'drafted_by_label', ''), v_batch.drafted_by_label)
           else r.drafted_by_label
         end,
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

revoke all on function public.advance_agh_handoff_batch(uuid, text, text, jsonb) from public;
revoke all on function public.advance_agh_handoff_batch(uuid, text, text, jsonb) from anon;
revoke all on function public.advance_agh_handoff_batch(uuid, text, text, jsonb) from authenticated;
grant execute on function public.advance_agh_handoff_batch(uuid, text, text, jsonb) to service_role;

comment on function public.advance_agh_handoff_batch(uuid, text, text, jsonb) is
  'Atomic CAS handoff advance. Draft stamps apply to batch AND records on CLAUDE_PLAYLIST_COMPLETE / AWAITING_GROK_REVIEW. SECURITY DEFINER; service_role only.';

commit;
