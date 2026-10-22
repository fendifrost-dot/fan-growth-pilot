-- The approved Instagram path, named in the data.
--
--   Claude composes the DM in the Hub -> Grok approves -> Muse sends -> Muse
--   records the receipt.
--
-- Instagram drafts were stamped send_mode = manual_from_artist_phone, which
-- told the sender they were hand-send only. They are not. This migration
-- re-creates the inventory persist RPC so new instagram_dm drafts and packets
-- carry send_mode = muse_instagram_send / send_owner = muse, and restamps the
-- Claude-authored drafts created before it. Body text, status, links and
-- approvals are untouched. Nothing is sent.
--
-- Apply via Lovable SQL Editor (paste, don't type). Idempotent.

begin;

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
  v_ig_drafts jsonb := '[]'::jsonb;
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
  v_ig_draft boolean;
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
    v_ig_draft := false;

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

    elsif v_channel = 'instagram_dm'
      and v_draft is not null
      and nullif(trim(v_draft->>'body'), '') is not null then
      -- Server-composed Instagram DM. The DM text lives on outreach_drafts only;
      -- the handoff packet carries the handle and the draft id, never the copy.
      v_ig_draft := true;
      v_recipient := coalesce(
        nullif(trim(v_draft->>'recipient'), ''),
        nullif(trim(v_packet->>'ig_curator_account'), '')
      );
      if v_recipient is null then
        raise exception 'instagram_dm ig_curator_account required for %', v_playlist
          using errcode = 'check_violation';
      end if;

      select id into v_draft_id
        from public.outreach_drafts
       where ops_idempotency_key = v_key
         and status in ('pending', 'approved')
       limit 1
       for update;

      if v_draft_id is null then
        insert into public.outreach_drafts (
          playlist_id, track_id, track_name, song_dna_version_id, channel,
          recipient, subject, body, generated_by, status,
          pitch_copy_source, pitch_copy_hash, ops_idempotency_key, metadata
        ) values (
          v_playlist,
          p_track_id,
          coalesce(v_draft->>'track_name', 'unknown'),
          p_song_dna_version_id,
          'instagram_dm',
          v_recipient,
          null,
          v_draft->>'body',
          coalesce(nullif(v_draft->>'generated_by', ''), v_drafted_by),
          'pending',
          v_draft->>'pitch_copy_source',
          v_draft->>'pitch_copy_hash',
          v_key,
          coalesce(v_draft->'metadata', '{}'::jsonb)
            || jsonb_build_object('automated_dm', false)
            || case when (v_draft->'metadata') ? 'send_mode' then '{}'::jsonb
                    else jsonb_build_object('send_mode', 'muse_instagram_send', 'send_owner', 'muse') end
        )
        returning id into v_draft_id;
      end if;

      v_packet := (
        v_packet || jsonb_build_object(
          'outreach_draft_id', v_draft_id,
          'ig_curator_account', coalesce(nullif(trim(v_packet->>'ig_curator_account'), ''), v_recipient),
          'packet_kind', coalesce(nullif(v_packet->>'packet_kind', ''), 'manual_ig_dm_packet'),
          'channel', 'instagram_dm',
          'automated_dm', false,
          'automated_submit', false,
          'send_owner', 'muse'
        )
      ) - 'body' - 'subject' - 'draft_body' - 'pitch' - 'pitch_body' - 'dm_body' - 'ig_dm_draft';

      v_ig_drafts := v_ig_drafts || jsonb_build_array(jsonb_build_object(
        'playlist_id', v_playlist,
        'outreach_draft_id', v_draft_id,
        'ig_curator_account', v_recipient,
        'idempotency_key', v_key
      ));
      v_manual := v_manual || jsonb_build_array(jsonb_build_object(
        'playlist_id', v_playlist,
        'channel', v_channel,
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

    -- The manual-send receipt path matches an approved instagram_dm draft to
    -- its handoff record through metadata.handoff_record_id. Stamp it now.
    if v_ig_draft and v_draft_id is not null then
      update public.outreach_drafts
         set metadata = coalesce(metadata, '{}'::jsonb)
           || jsonb_build_object('handoff_record_id', v_rec_id, 'handoff_batch_id', v_batch_id)
       where id = v_draft_id
         and coalesce(nullif(metadata->>'handoff_record_id', ''), '') = '';
    end if;

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
    'ig_dm_drafts', v_ig_drafts,
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
  'Single-transaction inventory persist. Email packets carry curator_email + outreach_draft_id. instagram_dm items that carry a server-composed draft also get an outreach_drafts row (channel instagram_dm, send_owner muse) linked from the record; packets never carry pitch copy.';

-- Restamp Claude-authored Instagram drafts that still say hand-send.
update public.outreach_drafts
   set metadata = coalesce(metadata, '{}'::jsonb)
     || jsonb_build_object('send_mode', 'muse_instagram_send', 'send_owner', 'muse')
 where channel = 'instagram_dm'
   and generated_by = 'claude_playlist_discovery'
   and coalesce(metadata->>'send_mode', '') = 'manual_from_artist_phone';

update public.agh_handoff_records r
   set packet = coalesce(r.packet, '{}'::jsonb) || jsonb_build_object('send_owner', 'muse')
  from public.outreach_drafts d
 where d.id = r.outreach_draft_id
   and r.submission_channel = 'instagram_dm'
   and d.generated_by = 'claude_playlist_discovery'
   and coalesce(r.packet->>'send_owner', '') = '';

commit;
