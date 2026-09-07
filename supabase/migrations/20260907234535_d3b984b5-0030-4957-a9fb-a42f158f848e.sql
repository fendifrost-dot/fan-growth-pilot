-- MCP OAuth refresh lifetime, rotation metadata, and expired-record cleanup.
-- Apply via Lovable SQL Editor after 20260907120000. Do NOT apply until authorized.

begin;

alter table public.agh_mcp_oauth_tokens
  add column if not exists refresh_expires_at timestamptz;

-- Backfill: 30-day refresh window from created_at for existing rows.
update public.agh_mcp_oauth_tokens
   set refresh_expires_at = created_at + interval '30 days'
 where refresh_expires_at is null;

alter table public.agh_mcp_oauth_tokens
  alter column refresh_expires_at set default (now() + interval '30 days');

create index if not exists agh_mcp_oauth_tokens_refresh_exp_idx
  on public.agh_mcp_oauth_tokens (refresh_expires_at)
  where revoked_at is null;

create index if not exists agh_mcp_oauth_codes_expires_idx
  on public.agh_mcp_oauth_codes (expires_at);

create or replace function public.agh_mcp_oauth_cleanup_expired()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  codes_deleted int := 0;
  tokens_deleted int := 0;
begin
  delete from public.agh_mcp_oauth_codes
   where expires_at < now();
  get diagnostics codes_deleted = row_count;

  delete from public.agh_mcp_oauth_tokens
   where (revoked_at is not null and revoked_at < now() - interval '7 days')
      or (expires_at < now() - interval '7 days' and refresh_expires_at < now());
  get diagnostics tokens_deleted = row_count;

  return jsonb_build_object(
    'ok', true,
    'codes_deleted', codes_deleted,
    'tokens_deleted', tokens_deleted
  );
end;
$$;

revoke all on function public.agh_mcp_oauth_cleanup_expired() from public, anon, authenticated;
grant execute on function public.agh_mcp_oauth_cleanup_expired() to service_role;

comment on function public.agh_mcp_oauth_cleanup_expired() is
  'Deletes expired OAuth codes and stale revoked/expired MCP tokens. service_role only.';

comment on column public.agh_mcp_oauth_tokens.refresh_expires_at is
  'Hard max lifetime for the refresh token family (default 30 days from mint).';

commit;