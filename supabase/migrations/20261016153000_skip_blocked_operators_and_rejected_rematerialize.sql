-- Materialize was cloning a fresh pending outreach_draft from a draft Grok
-- had already rejected, which put the same pitch back into review.
--
-- Rejected drafts are not cloned. A superseded unsent draft with copy can
-- still be cloned. Soundplate handoff records and drafts with
-- generated_by = 'fendi' are left unchanged (no packet rewrite, no clone,
-- no recipient fill). Web form and IG rows stay out of this function.
-- Never sends. dry_run defaults true.
--
-- Apply via Lovable SQL Editor (paste, don't type). Does not rewrite rows
-- by itself.
begin;

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
  v_soundplate boolean;
  v_fendi boolean;
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
           nullif(lower(trim(pt.curator_email)), '') as target_email,
           pt.submission_method as target_submission_method,
           pt.form_url as target_form_url,
           pt.submission_url as target_submission_url,
           pt.curator_website as target_curator_website
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
    v_soundplate := false;
    v_fendi := false;

    if v_rec.outreach_draft_id is not null then
      select * into v_draft from public.outreach_drafts where id = v_rec.outreach_draft_id;
    end if;

    -- Soundplate routes stay where they are. A target URL, a packet URL, or
    -- submission_method = soundplate is enough. Do not enrich or clone.
    v_soundplate :=
      coalesce(v_rec.target_submission_method, '') ilike 'soundplate'
      or coalesce(v_rec.packet->>'submission_method', '') ilike 'soundplate'
      or coalesce(v_rec.target_form_url, '') ~* '(://|\.)soundplate\.com([/:?#]|$)'
      or coalesce(v_rec.target_submission_url, '') ~* '(://|\.)soundplate\.com([/:?#]|$)'
      or coalesce(v_rec.target_curator_website, '') ~* '(://|\.)soundplate\.com([/:?#]|$)'
      or coalesce(v_rec.packet->>'form_url', '') ~* '(://|\.)soundplate\.com([/:?#]|$)'
      or coalesce(v_rec.packet->>'submission_url', '') ~* '(://|\.)soundplate\.com([/:?#]|$)';
    if v_soundplate then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
        'handoff_record_id', v_rec.record_id,
        'reason', 'soundplate_untouched'
      ));
      continue;
    end if;

    -- generated_by = 'fendi' drafts are not rewritten and not cloned.
    v_fendi := coalesce(v_draft.generated_by, '') = 'fendi'
      or exists (
        select 1
          from public.outreach_drafts fd
         where fd.generated_by = 'fendi'
           and (
             (v_rec.outreach_draft_id is not null and fd.id = v_rec.outreach_draft_id)
             or (
               coalesce(v_rec.packet->>'outreach_draft_id', '')
                 ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               and fd.id = (v_rec.packet->>'outreach_draft_id')::uuid
             )
           )
      );
    if v_fendi then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
        'handoff_record_id', v_rec.record_id,
        'reason', 'fendi_draft_untouched'
      ));
      continue;
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
    elsif lower(coalesce(v_draft.status, '')) = 'rejected' then
      -- A rejected draft stays rejected. Do not clone it back to pending.
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
        'handoff_record_id', v_rec.record_id,
        'reason', 'rejected_draft_not_cloned',
        'prior_draft_status', v_draft.status
      ));
      continue;
    elsif v_has_body then
      -- Superseded (or missing-status) unsent copy can still be cloned.
      -- Unique index only covers pending|approved.
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
           where id = v_draft.id
             and coalesce(generated_by, '') is distinct from 'fendi';
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
  'Durable email-handoff materialize. Enriches packets with curator_email + outreach_draft_id. Clones a pending draft for superseded unsent copy only. Does not clone rejected drafts. Does not update Soundplate records or generated_by=fendi drafts. Never sends. Never touches web_form/IG. dry_run defaults true.';

commit;
