-- OAuth 2.1 + opaque tokens for the remote MCP playlist-discovery connector.
-- Apply via Lovable SQL Editor after review. Do NOT apply until authorized.

begin;

create table if not exists public.agh_mcp_oauth_clients (
  client_id text primary key,
  client_secret_hash text,
  client_name text,
  redirect_uris text[] not null default '{}',
  grant_types text[] not null default array['authorization_code', 'refresh_token'],
  token_endpoint_auth_method text not null default 'client_secret_post',
  created_at timestamptz not null default now()
);

create table if not exists public.agh_mcp_oauth_codes (
  code_hash text primary key,
  client_id text not null references public.agh_mcp_oauth_clients(client_id) on delete cascade,
  redirect_uri text not null,
  code_challenge text not null,
  code_challenge_method text not null default 'S256',
  scope text not null default 'playlist_discovery',
  authorized_by_user_id uuid,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists public.agh_mcp_oauth_tokens (
  token_hash text primary key,
  refresh_token_hash text unique,
  client_id text not null references public.agh_mcp_oauth_clients(client_id) on delete cascade,
  scope text not null default 'playlist_discovery',
  actor_kind text not null default 'claude_playlist_discovery'
    check (actor_kind = 'claude_playlist_discovery'),
  authorized_by_user_id uuid,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create index if not exists agh_mcp_oauth_tokens_client_idx
  on public.agh_mcp_oauth_tokens (client_id);

alter table public.agh_mcp_oauth_clients enable row level security;
alter table public.agh_mcp_oauth_codes enable row level security;
alter table public.agh_mcp_oauth_tokens enable row level security;

-- No authenticated policies — service_role (edge) only.
revoke all on public.agh_mcp_oauth_clients from anon, authenticated;
revoke all on public.agh_mcp_oauth_codes from anon, authenticated;
revoke all on public.agh_mcp_oauth_tokens from anon, authenticated;

grant all on public.agh_mcp_oauth_clients to service_role;
grant all on public.agh_mcp_oauth_codes to service_role;
grant all on public.agh_mcp_oauth_tokens to service_role;

comment on table public.agh_mcp_oauth_tokens is
  'Opaque OAuth tokens for mcp-playlist-discovery. Always map to claude_playlist_discovery; never store raw tokens.';

commit;