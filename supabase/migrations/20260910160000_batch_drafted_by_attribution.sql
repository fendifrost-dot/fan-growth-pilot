-- Batch-level drafted_by attribution for Claude playlist inventory.
-- Fix: agh_mcp_persist_playlist_inventory wrote discovered_by on batches but left
-- drafted_by null while records were correctly attributed.
-- Also: safe historical backfill for unambiguous batches only.

begin;

-- ---------------------------------------------------------------------------
-- 1. Persist RPC: stamp batch drafted_by from server attr (never caller body)
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

  -- p_attr is service_role-only and must be built from authenticated edge identity.
  v_discovered_by := coalesce(nullif(p_attr->>'discovered_by', ''), 'claude_playlist_discovery');
  v_discovered_label := coalesce(nullif(p_attr->>'discovered_by_label', ''), v_discovered_by);
  v_drafted_by := coalesce(
    nullif(p_attr->>'drafted_by', ''),
    v_discovered_by
  );
  v_drafted_label := coalesce(
    nullif(p_attr->>'drafted_by_label', ''),
    nullif(p_attr->>'discovered_by_label', ''),
    v_drafted_by
  );

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
    -- Repair null batch drafted_by on idempotent reuse when attr is unambiguous.
    if v_existing_batch is not null then
      update public.agh_handoff_batches b
         set drafted_by = coalesce(b.drafted_by, v_drafted_by),
             drafted_by_label = coalesce(b.drafted_by_label, v_drafted_label),
             updated_at = now()
       where b.id = v_existing_batch
         and b.drafted_by is null;
    end if;
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
    discovered_by, discovered_by_label,
    drafted_by, drafted_by_label,
    record_count
  ) values (
    'playlist', 'CLAUDE_BATCH_READY', p_track_id, p_song_dna_version_id,
    v_discovered_by, v_discovered_label,
    v_drafted_by, v_drafted_label,
    0
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
      if v_existing_batch is not null then
        update public.agh_handoff_batches b
           set drafted_by = coalesce(b.drafted_by, v_drafted_by),
               drafted_by_label = coalesce(b.drafted_by_label, v_drafted_label),
               updated_at = now()
         where b.id = v_existing_batch
           and b.drafted_by is null;
      end if;
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
  'Single-transaction inventory persist: batch + drafts + records with discovered_by and drafted_by stamped from authenticated server attr. Failures roll back completely.';

-- ---------------------------------------------------------------------------
-- 2. Reconciliation flag table (does not change batch queue_state)
-- ---------------------------------------------------------------------------
create table if not exists public.agh_batch_attribution_reconciliation (
  batch_id uuid primary key references public.agh_handoff_batches(id) on delete cascade,
  reason text not null,
  actors text[] not null default '{}',
  created_at timestamptz not null default now()
);

comment on table public.agh_batch_attribution_reconciliation is
  'Batches whose drafted_by could not be safely backfilled (mixed/missing record actors).';

-- ---------------------------------------------------------------------------
-- 3. Safe backfill: one authenticated actor across all records, else flag
-- ---------------------------------------------------------------------------
create or replace function public.agh_backfill_batch_drafted_by()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated int := 0;
  v_flagged int := 0;
  v_row record;
  v_actors text[];
  v_actor text;
  v_label text;
  v_authenticated text[] := array[
    'claude_playlist_discovery',
    'claude',
    'grok_playlist_control',
    'fendi',
    'scheduler',
    'service',
    'human_admin'
  ];
begin
  for v_row in
    select b.id as batch_id
      from public.agh_handoff_batches b
     where b.drafted_by is null
       and b.batch_kind = 'playlist'
  loop
    select array_agg(distinct actor order by actor)
      into v_actors
      from (
        select nullif(trim(coalesce(r.drafted_by, r.discovered_by)), '') as actor
          from public.agh_handoff_records r
         where r.batch_id = v_row.batch_id
      ) s
     where actor is not null;

    if v_actors is null or cardinality(v_actors) = 0 then
      insert into public.agh_batch_attribution_reconciliation (batch_id, reason, actors)
      values (v_row.batch_id, 'no_record_actor', '{}')
      on conflict (batch_id) do update
        set reason = excluded.reason,
            actors = excluded.actors,
            created_at = now();
      v_flagged := v_flagged + 1;
      continue;
    end if;

    if cardinality(v_actors) > 1 then
      insert into public.agh_batch_attribution_reconciliation (batch_id, reason, actors)
      values (v_row.batch_id, 'mixed_record_actors', v_actors)
      on conflict (batch_id) do update
        set reason = excluded.reason,
            actors = excluded.actors,
            created_at = now();
      v_flagged := v_flagged + 1;
      continue;
    end if;

    v_actor := v_actors[1];
    if not (v_actor = any (v_authenticated)) then
      insert into public.agh_batch_attribution_reconciliation (batch_id, reason, actors)
      values (v_row.batch_id, 'unauthenticated_actor', v_actors)
      on conflict (batch_id) do update
        set reason = excluded.reason,
            actors = excluded.actors,
            created_at = now();
      v_flagged := v_flagged + 1;
      continue;
    end if;

    select coalesce(
             (
               select nullif(trim(r.drafted_by_label), '')
                 from public.agh_handoff_records r
                where r.batch_id = v_row.batch_id
                  and coalesce(nullif(trim(r.drafted_by), ''), nullif(trim(r.discovered_by), '')) = v_actor
                  and nullif(trim(r.drafted_by_label), '') is not null
                limit 1
             ),
             (
               select nullif(trim(r.discovered_by_label), '')
                 from public.agh_handoff_records r
                where r.batch_id = v_row.batch_id
                  and coalesce(nullif(trim(r.drafted_by), ''), nullif(trim(r.discovered_by), '')) = v_actor
                  and nullif(trim(r.discovered_by_label), '') is not null
                limit 1
             ),
             v_actor
           )
      into v_label;

    update public.agh_handoff_batches
       set drafted_by = v_actor,
           drafted_by_label = v_label,
           updated_at = now()
     where id = v_row.batch_id
       and drafted_by is null;

    delete from public.agh_batch_attribution_reconciliation where batch_id = v_row.batch_id;
    v_updated := v_updated + 1;
  end loop;

  return jsonb_build_object(
    'ok', true,
    'updated', v_updated,
    'flagged_for_reconciliation', v_flagged
  );
end;
$$;

revoke all on function public.agh_backfill_batch_drafted_by()
  from public, anon, authenticated;
grant execute on function public.agh_backfill_batch_drafted_by()
  to service_role;

comment on function public.agh_backfill_batch_drafted_by is
  'Backfill null batch drafted_by only when all records share one authenticated actor; otherwise flag for reconciliation. Does not alter queue_state or record attribution.';

-- Apply safe backfill once at migration time (idempotent).
select public.agh_backfill_batch_drafted_by();

commit;
