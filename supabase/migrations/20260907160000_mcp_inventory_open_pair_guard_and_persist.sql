-- Guarded open-pair index + atomic inventory persist + active idempotency.
-- Apply via Lovable SQL Editor AFTER 20260907150000 (diagnostics must already be committed).
-- Do NOT apply until PR review authorizes production deploy.
-- If the duplicate preflight raises, diagnostic functions from 150000 remain installed.

begin;

-- ---------------------------------------------------------------------------
-- 1. Active-status idempotency index (allow retry after terminal statuses)
-- ---------------------------------------------------------------------------
drop index if exists public.outreach_drafts_ops_idempotency_uidx;

-- Active inventory only: pending + approved block duplicates.
-- Terminal (rejected, sent, superseded, cancelled, …) may reuse the same key.
create unique index if not exists outreach_drafts_ops_idempotency_active_uidx
  on public.outreach_drafts (ops_idempotency_key)
  where ops_idempotency_key is not null
    and status in ('pending', 'approved');

comment on index public.outreach_drafts_ops_idempotency_active_uidx is
  'One active (pending|approved) outreach_draft per track:playlist:channel:dna key. Terminal statuses do not block recovery.';

-- Stop deployment if live open-pair duplicates exist (never silently rewrite).
do $$
declare
  v_dupes bigint;
begin
  select count(*) into v_dupes from public.agh_mcp_handoff_open_pair_duplicate_report();
  if v_dupes > 0 then
    raise exception
      'PREFLIGHT FAIL: % open handoff pair duplicate group(s). Run select * from agh_mcp_handoff_open_pair_duplicate_report(); and agh_mcp_handoff_open_pair_reconcile_plan(); before creating agh_handoff_records_open_pair_uidx. No records were deleted.',
      v_dupes;
  end if;
end $$;

-- Create unique index only after a clean preflight (never created in 140000).
create unique index if not exists agh_handoff_records_open_pair_uidx
  on public.agh_handoff_records (
    track_id,
    playlist_target_id,
    submission_channel,
    song_dna_version_id
  )
  where track_id is not null
    and playlist_target_id is not null
    and submission_channel is not null
    and song_dna_version_id is not null
    and queue_state not in ('REJECTED_BY_GROK', 'IMPORTED_TO_AGH');

-- ---------------------------------------------------------------------------
-- 2. Safer emergency compensate: emptiness via locked count(*), ordered cleanup
-- ---------------------------------------------------------------------------
create or replace function public.agh_mcp_delete_empty_handoff_batch(p_batch_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_live int;
  v_deleted int;
begin
  if p_batch_id is null then
    return jsonb_build_object('ok', false, 'code', 'bad_request', 'error', 'batch_id required');
  end if;

  perform 1 from public.agh_handoff_batches where id = p_batch_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'not_found', 'error', 'batch not found');
  end if;

  select count(*)::int into v_live
    from public.agh_handoff_records
   where batch_id = p_batch_id;

  if v_live > 0 then
    return jsonb_build_object(
      'ok', false,
      'code', 'not_empty',
      'error', 'refusing to delete non-empty handoff batch (live count(*))',
      'live_record_count', v_live
    );
  end if;

  delete from public.agh_handoff_batches where id = p_batch_id;
  get diagnostics v_deleted = row_count;
  if v_deleted <> 1 then
    return jsonb_build_object('ok', false, 'code', 'delete_failed', 'error', 'batch delete affected 0 rows');
  end if;

  return jsonb_build_object('ok', true, 'deleted_batch_id', p_batch_id, 'live_record_count', 0);
end;
$$;

revoke all on function public.agh_mcp_delete_empty_handoff_batch(uuid) from public, anon, authenticated;
grant execute on function public.agh_mcp_delete_empty_handoff_batch(uuid) to service_role;

-- Emergency cleanup for a failed attempt: remove this batch's records first,
-- then empty batch, then only pending drafts in p_draft_ids that remain unlinked.
create or replace function public.agh_mcp_compensate_inventory_attempt(
  p_batch_id uuid,
  p_draft_ids uuid[]
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_recs_deleted int := 0;
  v_drafts_deleted int := 0;
  v_batch_deleted boolean := false;
  v_batch_result jsonb;
  v_live int;
  v_unlinked int;
begin
  if p_batch_id is not null then
    perform 1 from public.agh_handoff_batches where id = p_batch_id for update;

    delete from public.agh_handoff_records where batch_id = p_batch_id;
    get diagnostics v_recs_deleted = row_count;

    select count(*)::int into v_live
      from public.agh_handoff_records where batch_id = p_batch_id;
    if v_live <> 0 then
      return jsonb_build_object(
        'ok', false,
        'code', 'compensate_incomplete',
        'error', 'handoff records remain after compensate delete',
        'live_record_count', v_live,
        'records_deleted', v_recs_deleted
      );
    end if;

    v_batch_result := public.agh_mcp_delete_empty_handoff_batch(p_batch_id);
    if coalesce((v_batch_result->>'ok')::boolean, false) then
      v_batch_deleted := true;
    elsif v_batch_result->>'code' = 'not_found' then
      v_batch_deleted := true;
    else
      return jsonb_build_object(
        'ok', false,
        'code', 'compensate_incomplete',
        'error', 'batch cleanup failed',
        'batch_result', v_batch_result,
        'records_deleted', v_recs_deleted
      );
    end if;
  end if;

  if p_draft_ids is not null and array_length(p_draft_ids, 1) is not null then
    -- Only delete drafts we created in this attempt, still pending, and unlinked.
    -- Never delete a draft claimed by a concurrent successful handoff.
    delete from public.outreach_drafts d
     where d.id = any (p_draft_ids)
       and d.status = 'pending'
       and not exists (
         select 1 from public.agh_handoff_records r where r.outreach_draft_id = d.id
       );
    get diagnostics v_drafts_deleted = row_count;

    select count(*)::int into v_unlinked
      from public.outreach_drafts d
     where d.id = any (p_draft_ids)
       and d.status = 'pending'
       and not exists (
         select 1 from public.agh_handoff_records r where r.outreach_draft_id = d.id
       );
    if v_unlinked > 0 then
      return jsonb_build_object(
        'ok', false,
        'code', 'compensate_incomplete',
        'error', 'orphan pending drafts remain after compensate',
        'orphan_remaining', v_unlinked,
        'drafts_deleted', v_drafts_deleted,
        'records_deleted', v_recs_deleted,
        'batch_deleted', v_batch_deleted
      );
    end if;
  end if;

  return jsonb_build_object(
    'ok', true,
    'records_deleted', v_recs_deleted,
    'drafts_deleted', v_drafts_deleted,
    'batch_deleted', v_batch_deleted
  );
end;
$$;

revoke all on function public.agh_mcp_compensate_inventory_attempt(uuid, uuid[])
  from public, anon, authenticated;
grant execute on function public.agh_mcp_compensate_inventory_attempt(uuid, uuid[]) to service_role;

-- Keep orphan-key helper but restrict to pending + unlinked (never concurrent claims).
create or replace function public.agh_mcp_delete_orphan_drafts(p_keys text[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted int := 0;
begin
  if p_keys is null or array_length(p_keys, 1) is null then
    return jsonb_build_object('ok', true, 'deleted', 0);
  end if;

  delete from public.outreach_drafts d
   where d.ops_idempotency_key = any (p_keys)
     and d.status = 'pending'
     and not exists (
       select 1 from public.agh_handoff_records r where r.outreach_draft_id = d.id
     );

  get diagnostics v_deleted = row_count;
  return jsonb_build_object('ok', true, 'deleted', v_deleted);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Lookup matches active uniqueness rule
-- ---------------------------------------------------------------------------
create or replace function public.agh_mcp_lookup_inventory_pair(
  p_track_id uuid,
  p_playlist_id text,
  p_channel text,
  p_song_dna_version_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key text;
  v_draft public.outreach_drafts%rowtype;
  v_rec public.agh_handoff_records%rowtype;
  v_batch public.agh_handoff_batches%rowtype;
begin
  if p_track_id is null or p_playlist_id is null or p_channel is null or p_song_dna_version_id is null then
    return jsonb_build_object('ok', false, 'code', 'bad_request', 'error', 'identity fields required');
  end if;

  v_key := p_track_id::text || ':' || p_playlist_id || ':' || p_channel || ':' || p_song_dna_version_id::text;

  select * into v_draft
    from public.outreach_drafts
   where ops_idempotency_key = v_key
     and status in ('pending', 'approved')
   order by generated_at desc nulls last
   limit 1;

  select * into v_rec
    from public.agh_handoff_records
   where track_id = p_track_id
     and playlist_target_id = p_playlist_id
     and submission_channel = p_channel
     and song_dna_version_id = p_song_dna_version_id
     and queue_state not in ('REJECTED_BY_GROK', 'IMPORTED_TO_AGH')
   order by created_at desc
   limit 1;

  if v_rec.id is not null then
    select * into v_batch from public.agh_handoff_batches where id = v_rec.batch_id;
  end if;

  if v_draft.id is null and v_rec.id is null then
    return jsonb_build_object('ok', true, 'found', false, 'idempotency_key', v_key);
  end if;

  return jsonb_build_object(
    'ok', true,
    'found', true,
    'idempotency_key', v_key,
    'outreach_draft_id', v_draft.id,
    'draft_status', v_draft.status,
    'handoff_record_id', v_rec.id,
    'batch_id', coalesce(v_rec.batch_id, v_batch.id),
    'batch_queue_state', v_batch.queue_state
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Atomic inventory persist (one transaction for batch + drafts + records)
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
  v_retry jsonb;
  v_race_all boolean;
begin
  if p_track_id is null or p_song_dna_version_id is null then
    return jsonb_build_object('ok', false, 'code', 'bad_request', 'error', 'track and dna required');
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) < 1 then
    return jsonb_build_object('ok', false, 'code', 'bad_request', 'error', 'items required');
  end if;

  v_discovered_by := coalesce(p_attr->>'discovered_by', 'claude_playlist_discovery');
  v_discovered_label := coalesce(p_attr->>'discovered_by_label', v_discovered_by);

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
    discovered_by, discovered_by_label, record_count
  ) values (
    'playlist', 'CLAUDE_BATCH_READY', p_track_id, p_song_dna_version_id,
    v_discovered_by, v_discovered_label, 0
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
      v_discovered_by,
      v_discovered_label
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
  'Single-transaction inventory persist: batch + drafts (with active idempotency keys) + handoff records + authoritative count(*). Failures roll back completely.';

commit;
