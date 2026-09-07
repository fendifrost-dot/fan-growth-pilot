-- Final operational amendment: inventory idempotency keys + atomic OAuth consume/rotate.
-- Apply via Lovable SQL Editor AFTER 20260907120000 + 20260907130000.
-- Do NOT apply until PR review authorizes production deploy.

begin;

-- ---------------------------------------------------------------------------
-- 1. outreach_drafts ops idempotency (track + playlist + channel + DNA)
-- ---------------------------------------------------------------------------
alter table public.outreach_drafts
  add column if not exists ops_idempotency_key text;

comment on column public.outreach_drafts.ops_idempotency_key is
  'Deterministic identity: track_id:playlist_id:channel:song_dna_version_id. Prevents duplicate pending drafts.';

create unique index if not exists outreach_drafts_ops_idempotency_uidx
  on public.outreach_drafts (ops_idempotency_key)
  where ops_idempotency_key is not null;

-- Open-pair uniqueness for handoff records (channel included via submission_channel).
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
-- 2. Compensate: delete empty handoff batch (fail closed if not empty / missing)
-- ---------------------------------------------------------------------------
create or replace function public.agh_mcp_delete_empty_handoff_batch(p_batch_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
  v_deleted int;
begin
  if p_batch_id is null then
    return jsonb_build_object('ok', false, 'code', 'bad_request', 'error', 'batch_id required');
  end if;

  select coalesce(record_count, 0) into v_count
    from public.agh_handoff_batches
   where id = p_batch_id;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'not_found', 'error', 'batch not found');
  end if;

  if v_count > 0 then
    return jsonb_build_object(
      'ok', false,
      'code', 'not_empty',
      'error', 'refusing to delete non-empty handoff batch',
      'record_count', v_count
    );
  end if;

  delete from public.agh_handoff_batches where id = p_batch_id and coalesce(record_count, 0) = 0;
  get diagnostics v_deleted = row_count;
  if v_deleted <> 1 then
    return jsonb_build_object('ok', false, 'code', 'delete_failed', 'error', 'batch delete affected 0 rows');
  end if;

  return jsonb_build_object('ok', true, 'deleted_batch_id', p_batch_id);
end;
$$;

revoke all on function public.agh_mcp_delete_empty_handoff_batch(uuid) from public, anon, authenticated;
grant execute on function public.agh_mcp_delete_empty_handoff_batch(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Compensate: delete orphan pending drafts by idempotency keys (unlinked)
-- ---------------------------------------------------------------------------
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
       select 1 from public.agh_handoff_records r
        where r.outreach_draft_id = d.id
     );

  get diagnostics v_deleted = row_count;
  return jsonb_build_object('ok', true, 'deleted', v_deleted);
end;
$$;

revoke all on function public.agh_mcp_delete_orphan_drafts(text[]) from public, anon, authenticated;
grant execute on function public.agh_mcp_delete_orphan_drafts(text[]) to service_role;

-- ---------------------------------------------------------------------------
-- 4. Lookup existing inventory pair (idempotent retry)
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
    'batch_id', v_rec.batch_id,
    'batch_queue_state', v_batch.queue_state
  );
end;
$$;

revoke all on function public.agh_mcp_lookup_inventory_pair(uuid, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.agh_mcp_lookup_inventory_pair(uuid, text, text, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Atomic OAuth: consume authorization code once + mint tokens
-- ---------------------------------------------------------------------------
create or replace function public.agh_mcp_consume_oauth_code(
  p_code_hash text,
  p_client_id text,
  p_redirect_uri text,
  p_expected_challenge text,
  p_access_token_hash text,
  p_refresh_token_hash text,
  p_access_expires_at timestamptz,
  p_refresh_expires_at timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code public.agh_mcp_oauth_codes%rowtype;
  v_deleted int;
begin
  if p_code_hash is null or p_client_id is null or p_access_token_hash is null or p_refresh_token_hash is null then
    return jsonb_build_object('ok', false, 'code', 'bad_request', 'error', 'required fields missing');
  end if;

  select * into v_code
    from public.agh_mcp_oauth_codes
   where code_hash = p_code_hash
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'invalid_grant', 'error', 'code not found or already used');
  end if;

  if v_code.expires_at < now() then
    delete from public.agh_mcp_oauth_codes where code_hash = p_code_hash;
    return jsonb_build_object('ok', false, 'code', 'invalid_grant', 'error', 'code expired');
  end if;

  if v_code.client_id is distinct from p_client_id
     or v_code.redirect_uri is distinct from p_redirect_uri then
    return jsonb_build_object('ok', false, 'code', 'invalid_grant', 'error', 'client/redirect mismatch');
  end if;

  if p_expected_challenge is not null
     and v_code.code_challenge is distinct from p_expected_challenge then
    return jsonb_build_object('ok', false, 'code', 'invalid_grant', 'error', 'pkce_failed');
  end if;

  delete from public.agh_mcp_oauth_codes where code_hash = p_code_hash;
  get diagnostics v_deleted = row_count;
  if v_deleted <> 1 then
    return jsonb_build_object('ok', false, 'code', 'invalid_grant', 'error', 'code already consumed');
  end if;

  insert into public.agh_mcp_oauth_tokens (
    token_hash, refresh_token_hash, client_id, scope, actor_kind,
    authorized_by_user_id, expires_at, refresh_expires_at
  ) values (
    p_access_token_hash, p_refresh_token_hash, p_client_id, 'playlist_discovery',
    'claude_playlist_discovery', v_code.authorized_by_user_id,
    p_access_expires_at, p_refresh_expires_at
  );

  return jsonb_build_object(
    'ok', true,
    'authorized_by_user_id', v_code.authorized_by_user_id,
    'scope', 'playlist_discovery',
    'actor_kind', 'claude_playlist_discovery'
  );
exception
  when unique_violation then
    return jsonb_build_object('ok', false, 'code', 'conflict', 'error', 'token hash collision');
end;
$$;

revoke all on function public.agh_mcp_consume_oauth_code(
  text, text, text, text, text, text, timestamptz, timestamptz
) from public, anon, authenticated;
grant execute on function public.agh_mcp_consume_oauth_code(
  text, text, text, text, text, text, timestamptz, timestamptz
) to service_role;

-- ---------------------------------------------------------------------------
-- 6. Atomic OAuth: rotate refresh-token family once (preserve refresh_expires_at)
-- ---------------------------------------------------------------------------
create or replace function public.agh_mcp_rotate_oauth_refresh(
  p_refresh_token_hash text,
  p_client_id text,
  p_new_access_token_hash text,
  p_new_refresh_token_hash text,
  p_access_expires_at timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tok public.agh_mcp_oauth_tokens%rowtype;
  v_updated int;
begin
  if p_refresh_token_hash is null or p_client_id is null
     or p_new_access_token_hash is null or p_new_refresh_token_hash is null then
    return jsonb_build_object('ok', false, 'code', 'bad_request', 'error', 'required fields missing');
  end if;

  select * into v_tok
    from public.agh_mcp_oauth_tokens
   where refresh_token_hash = p_refresh_token_hash
     and revoked_at is null
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'invalid_grant', 'error', 'refresh not found or revoked');
  end if;

  if v_tok.client_id is distinct from p_client_id then
    return jsonb_build_object('ok', false, 'code', 'invalid_grant', 'error', 'client mismatch');
  end if;

  if v_tok.refresh_expires_at is null or v_tok.refresh_expires_at < now() then
    update public.agh_mcp_oauth_tokens
       set revoked_at = now()
     where token_hash = v_tok.token_hash;
    return jsonb_build_object('ok', false, 'code', 'invalid_grant', 'error', 'refresh_expired');
  end if;

  update public.agh_mcp_oauth_tokens
     set revoked_at = now()
   where token_hash = v_tok.token_hash
     and revoked_at is null;
  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    return jsonb_build_object('ok', false, 'code', 'invalid_grant', 'error', 'refresh already rotated');
  end if;

  insert into public.agh_mcp_oauth_tokens (
    token_hash, refresh_token_hash, client_id, scope, actor_kind,
    authorized_by_user_id, expires_at, refresh_expires_at
  ) values (
    p_new_access_token_hash, p_new_refresh_token_hash, p_client_id, v_tok.scope,
    'claude_playlist_discovery', v_tok.authorized_by_user_id,
    p_access_expires_at, v_tok.refresh_expires_at
  );

  return jsonb_build_object(
    'ok', true,
    'authorized_by_user_id', v_tok.authorized_by_user_id,
    'refresh_expires_at', v_tok.refresh_expires_at,
    'scope', v_tok.scope
  );
exception
  when unique_violation then
    return jsonb_build_object('ok', false, 'code', 'conflict', 'error', 'token hash collision');
end;
$$;

revoke all on function public.agh_mcp_rotate_oauth_refresh(
  text, text, text, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.agh_mcp_rotate_oauth_refresh(
  text, text, text, text, timestamptz
) to service_role;

comment on function public.agh_mcp_consume_oauth_code is
  'Atomically consume one OAuth auth code and mint tokens. Concurrent callers: exactly one success.';
comment on function public.agh_mcp_rotate_oauth_refresh is
  'Atomically rotate one refresh-token family; preserves refresh_expires_at. Concurrent callers: exactly one success.';

commit;
