-- Sync MCP OAuth tokens must follow the authorization code's scope.
--
-- Live agh_mcp_consume_oauth_code (from 20260907140000 / 20260907234632) ignored
-- agh_mcp_oauth_codes.scope and always inserted
--   scope = 'playlist_discovery', actor_kind = 'claude_playlist_discovery'.
-- The actor check constraint also allowed only claude_playlist_discovery.
-- Section 5 of 20260911150000_sync_operating_stack.sql already contained this
-- fix, but that function body never replaced the live one. Playlist consent
-- still worked because the hardcoded actor matches that connector. Sync consent
-- stored scope sync_discovery on the code, then the token endpoint minted a
-- playlist token. mcp-sync-discovery rejected it (invalid_actor). Claude treated
-- the 401 as an expired token, refresh-rotated the same playlist actor, and
-- reported "Authorization failed" with an empty tool list.
--
-- Idempotent. Does not touch tracks, registers, or existing playlist tokens.
-- Apply via Lovable SQL Editor (paste).

begin;

alter table public.agh_mcp_oauth_tokens
  drop constraint if exists agh_mcp_oauth_tokens_actor_kind_check;

alter table public.agh_mcp_oauth_tokens
  add constraint agh_mcp_oauth_tokens_actor_kind_check
  check (actor_kind in ('claude_playlist_discovery', 'claude_sync_discovery'));

comment on table public.agh_mcp_oauth_tokens is
  'Opaque OAuth tokens for MCP connectors. actor_kind is scope-bound: playlist_discovery→claude_playlist_discovery, sync_discovery→claude_sync_discovery.';

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
  v_scope text;
  v_actor text;
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

  v_scope := coalesce(nullif(trim(v_code.scope), ''), 'playlist_discovery');
  if v_scope = 'sync_discovery' then
    v_actor := 'claude_sync_discovery';
  elsif v_scope = 'playlist_discovery' then
    v_actor := 'claude_playlist_discovery';
  else
    return jsonb_build_object('ok', false, 'code', 'invalid_scope', 'error', 'unsupported scope');
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
    p_access_token_hash, p_refresh_token_hash, p_client_id, v_scope,
    v_actor, v_code.authorized_by_user_id,
    p_access_expires_at, p_refresh_expires_at
  );

  return jsonb_build_object(
    'ok', true,
    'authorized_by_user_id', v_code.authorized_by_user_id,
    'scope', v_scope,
    'actor_kind', v_actor
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
    v_tok.actor_kind, v_tok.authorized_by_user_id,
    p_access_expires_at, v_tok.refresh_expires_at
  );

  return jsonb_build_object(
    'ok', true,
    'authorized_by_user_id', v_tok.authorized_by_user_id,
    'refresh_expires_at', v_tok.refresh_expires_at,
    'scope', v_tok.scope,
    'actor_kind', v_tok.actor_kind
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
  'Atomically consume one OAuth auth code and mint tokens bound to that code scope (playlist_discovery or sync_discovery).';
comment on function public.agh_mcp_rotate_oauth_refresh is
  'Atomically rotate one refresh-token family; preserves scope, actor_kind, and refresh_expires_at.';

commit;
