-- Email handoff packets must carry curator_email + outreach_draft_id so
-- Playlist Control list_drafts / PASS-send can find a real outreach_drafts row.
-- Persist previously stored a metadata-only shell and left draft linkage only
-- on agh_handoff_records.outreach_draft_id. Promote-to-AWAITING did not rewrite
-- packets, so Grok saw thin shells even when a draft FK existed.
--
-- Also: a durable materialize RPC that
--   * enriches packets from the linked draft / playlist_targets.curator_email
--   * clones a NEW pending outreach_draft when the linked draft is terminal
--     (rejected/superseded) AND the pair has no pitch_log sent row
--   * NEVER clones already-sent pairs (no duplicate Resend)
--   * NEVER touches web_form / instagram_dm
--   * NEVER sends mail
--
-- Apply via Lovable SQL Editor (paste, don't type). Does not rewrite rows by
-- itself — call agh_materialize_email_handoff_drafts(false) for the one-shot.

begin;

-- ---------------------------------------------------------------------------
-- Packet merge helper (metadata only — never pitch copy)
-- ---------------------------------------------------------------------------
create or replace function public.agh_email_handoff_packet_merge(
  p_packet jsonb,
  p_outreach_draft_id uuid,
  p_curator_email text,
  p_email_sendable boolean,
  p_strip_copy boolean default false
) returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  v_out jsonb := coalesce(p_packet, '{}'::jsonb);
  v_email text := nullif(lower(trim(p_curator_email)), '');
begin
  if p_outreach_draft_id is null or v_email is null then
    raise exception 'email packet merge requires outreach_draft_id and curator_email'
      using errcode = 'check_violation';
  end if;
  v_out := v_out || jsonb_build_object(
    'outreach_draft_id', p_outreach_draft_id,
    'curator_email', v_email,
    'packet_kind', coalesce(nullif(v_out->>'packet_kind', ''), 'email_outreach_draft'),
    'channel', 'email',
    'email_sendable', p_email_sendable
  );
  if p_strip_copy then
    v_out := v_out
      - 'body' - 'subject' - 'draft_body' - 'email_body' - 'pitch_body'
      - 'pitch' - 'ig_dm_draft';
  end if;
  return v_out;
end;
$$;

revoke all on function public.agh_email_handoff_packet_merge(jsonb, uuid, text, boolean, boolean)
  from public, anon, authenticated;
grant execute on function public.agh_email_handoff_packet_merge(jsonb, uuid, text, boolean, boolean)
  to service_role;

-- ---------------------------------------------------------------------------
-- Persist RPC: write curator_email + outreach_draft_id onto the email packet
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
  v_recipient text;
  v_target_email text;
begin
  if p_track_id is null or p_song_dna_version_id is null then
    return jsonb_build_object('ok', false, 'code', 'bad_request', 'error', 'track and dna required');
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) < 1 then
    return jsonb_build_object('ok', false, 'code', 'bad_request', 'error', 'items required');
  end if;

  v_discovered_by := coalesce(nullif(p_attr->>'discovered_by', ''), 'claude_playlist_discovery');
  v_discovered_label := coalesce(nullif(p_attr->>'discovered_by_label', ''), v_discovered_by);
  v_drafted_by := coalesce(nullif(p_attr->>'drafted_by', ''), v_discovered_by);
  v_drafted_label := coalesce(nullif(p_attr->>'drafted_by_label', ''), v_discovered_label);

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
    v_recipient := null;
    v_target_email := null;

    if v_channel = 'email' then
      select nullif(lower(trim(curator_email)), '') into v_target_email
        from public.playlist_targets
       where playlist_id = v_playlist;

      v_recipient := coalesce(
        nullif(lower(trim(v_packet->>'curator_email')), ''),
        nullif(lower(trim(v_draft->>'recipient')), ''),
        v_target_email
      );

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
        if v_recipient is null then
          raise exception 'email curator_email required for %', v_playlist
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
          v_recipient,
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
      elsif v_recipient is null then
        select nullif(lower(trim(recipient)), '') into v_recipient
          from public.outreach_drafts where id = v_draft_id;
      end if;

      if v_draft_id is null then
        raise exception 'email outreach_draft_id required for %', v_playlist
          using errcode = 'check_violation';
      end if;
      if v_recipient is null then
        raise exception 'email curator_email required for %', v_playlist
          using errcode = 'check_violation';
      end if;

      update public.outreach_drafts
         set recipient = coalesce(nullif(trim(recipient), ''), v_recipient)
       where id = v_draft_id
         and coalesce(nullif(trim(recipient), ''), '') = '';

      v_packet := public.agh_email_handoff_packet_merge(
        v_packet, v_draft_id, v_recipient, true, true
      );

      v_email_drafts := v_email_drafts || jsonb_build_array(jsonb_build_object(
        'playlist_id', v_playlist,
        'outreach_draft_id', v_draft_id,
        'curator_email', v_recipient,
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
  'Single-transaction inventory persist. Email packets always include curator_email + outreach_draft_id (no pitch copy). Drafts get recipient from packet/draft/playlist_targets.';

-- ---------------------------------------------------------------------------
-- One-shot / durable materialize for thin email shells already in review
-- ---------------------------------------------------------------------------
create or replace function public.agh_materialize_email_handoff_drafts(
  p_dry_run boolean default true,
  p_batch_id uuid default null,
  p_track_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_has_pitch_log boolean := to_regclass('public.pitch_log') is not null;
  v_rec record;
  v_scanned int := 0;
  v_enriched int := 0;
  v_cloned int := 0;
  v_already_sent int := 0;
  v_skipped jsonb := '[]'::jsonb;
  v_items jsonb := '[]'::jsonb;
  v_email text;
  v_draft public.outreach_drafts%rowtype;
  v_new_id uuid;
  v_actionable boolean;
  v_sent boolean;
  v_has_body boolean;
  v_sendable boolean;
  v_action text;
  v_logged_sent boolean;
begin
  for v_rec in
    select r.id as record_id,
           r.batch_id,
           r.track_id,
           r.playlist_target_id,
           r.song_dna_version_id,
           r.outreach_draft_id,
           r.dedupe_key,
           r.queue_state,
           r.packet,
           r.drafted_by,
           t.name as track_name,
           nullif(lower(trim(pt.curator_email)), '') as target_email
      from public.agh_handoff_records r
      join public.agh_handoff_batches b on b.id = r.batch_id
      left join public.tracks t on t.id = r.track_id
      left join public.playlist_targets pt on pt.playlist_id = r.playlist_target_id
     where b.batch_kind = 'playlist'
       and r.submission_channel = 'email'
       and r.queue_state in (
         'AWAITING_GROK_REVIEW',
         'CLAUDE_BATCH_READY',
         'CLAUDE_PLAYLIST_COMPLETE'
       )
       and (p_batch_id is null or r.batch_id = p_batch_id)
       and (p_track_id is null or r.track_id = p_track_id)
     order by r.created_at
  loop
    v_scanned := v_scanned + 1;
    v_draft := null;
    v_new_id := null;
    v_action := null;
    v_logged_sent := false;

    if v_rec.outreach_draft_id is not null then
      select * into v_draft from public.outreach_drafts where id = v_rec.outreach_draft_id;
    end if;

    v_email := coalesce(
      nullif(lower(trim(v_rec.packet->>'curator_email')), ''),
      nullif(lower(trim(v_draft.recipient)), ''),
      v_rec.target_email
    );

    if v_has_pitch_log then
      execute
        'select exists (
           select 1 from public.pitch_log p
            where p.playlist_id = $1
              and p.status = ''sent''
              and (
                ($2 is not null and p.track_id = $2)
                or ($3 is not null and p.track_name = $3)
              )
         )'
        into v_logged_sent
        using v_rec.playlist_target_id, v_rec.track_id, v_rec.track_name;
    end if;

    v_sent := (v_draft.status = 'sent') or v_logged_sent;
    v_has_body := coalesce(nullif(v_draft.body, ''), '') <> '';
    v_actionable := v_draft.id is not null
      and v_draft.status in ('pending', 'approved')
      and v_has_body
      and v_email is not null;

    if v_email is null then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
        'handoff_record_id', v_rec.record_id,
        'reason', 'missing_curator_email'
      ));
      continue;
    end if;

    if v_sent then
      v_sendable := false;
      v_action := 'packet_enriched_already_sent';
      v_already_sent := v_already_sent + 1;
      if v_draft.id is null then
        v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
          'handoff_record_id', v_rec.record_id,
          'reason', 'already_sent_without_draft'
        ));
        continue;
      end if;
    elsif v_actionable then
      v_sendable := true;
      v_action := 'packet_enriched';
    elsif v_has_body then
      -- Terminal (rejected/superseded) or missing-status draft with copy —
      -- clone a fresh pending row. Unique index only covers pending|approved.
      v_sendable := true;
      v_action := 'cloned_pending_draft';
    else
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
        'handoff_record_id', v_rec.record_id,
        'reason', 'compose_required'
      ));
      continue;
    end if;

    if v_action = 'cloned_pending_draft' then
      v_cloned := v_cloned + 1;
      if not p_dry_run then
        insert into public.outreach_drafts (
          playlist_id, track_id, track_name, song_dna_version_id, channel,
          recipient, subject, body, generated_by, status,
          pitch_copy_source, pitch_copy_hash, ops_idempotency_key, metadata
        ) values (
          coalesce(v_draft.playlist_id, v_rec.playlist_target_id),
          v_rec.track_id,
          coalesce(nullif(v_draft.track_name, ''), v_rec.track_name, 'unknown'),
          coalesce(v_rec.song_dna_version_id, v_draft.song_dna_version_id),
          'email',
          v_email,
          v_draft.subject,
          v_draft.body,
          coalesce(v_draft.generated_by, v_rec.drafted_by, 'claude_playlist_discovery'),
          'pending',
          v_draft.pitch_copy_source,
          v_draft.pitch_copy_hash,
          coalesce(v_rec.dedupe_key, v_draft.ops_idempotency_key),
          coalesce(v_draft.metadata, '{}'::jsonb) || jsonb_build_object(
            'materialized_from_draft_id', v_draft.id,
            'materialized_reason', 'terminal_unsent_handoff'
          )
        )
        returning id into v_new_id;

        update public.agh_handoff_records
           set outreach_draft_id = v_new_id,
               packet = public.agh_email_handoff_packet_merge(
                 packet, v_new_id, v_email, true, false
               ),
               updated_at = now()
         where id = v_rec.record_id;
      end if;
    else
      v_enriched := v_enriched + 1;
      if not p_dry_run then
        if v_actionable and coalesce(nullif(trim(v_draft.recipient), ''), '') = '' then
          update public.outreach_drafts
             set recipient = v_email
           where id = v_draft.id;
        end if;
        update public.agh_handoff_records
           set packet = public.agh_email_handoff_packet_merge(
                 packet, v_draft.id, v_email, v_sendable, false
               ),
               updated_at = now()
         where id = v_rec.record_id;
      end if;
    end if;

    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'handoff_record_id', v_rec.record_id,
      'batch_id', v_rec.batch_id,
      'action', v_action,
      'email_sendable', v_sendable,
      'outreach_draft_id', coalesce(v_new_id, v_draft.id),
      'prior_draft_status', v_draft.status
    ));
  end loop;

  return jsonb_build_object(
    'ok', true,
    'dry_run', p_dry_run,
    'scanned', v_scanned,
    'packet_enriched', v_enriched,
    'cloned_pending', v_cloned,
    'already_sent', v_already_sent,
    'skipped', v_skipped,
    'items', v_items
  );
end;
$$;

revoke all on function public.agh_materialize_email_handoff_drafts(boolean, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.agh_materialize_email_handoff_drafts(boolean, uuid, uuid)
  to service_role;

comment on function public.agh_materialize_email_handoff_drafts is
  'Durable email-handoff materialize. Enriches packets with curator_email + outreach_draft_id. Clones pending drafts only for terminal-unsent pairs. Never sends. Never touches web_form/IG. dry_run defaults true.';

commit;
