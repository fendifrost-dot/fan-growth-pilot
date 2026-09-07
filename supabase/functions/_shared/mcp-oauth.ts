/**
 * OAuth 2.1 (PKCE S256) + Dynamic Client Registration helpers for the
 * mcp-playlist-discovery remote connector. Tokens always bind to
 * claude_playlist_discovery — never expose service-role or broad Claude secrets.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const SCOPE = "playlist_discovery";
const ACTOR = "claude_playlist_discovery";

export function mcpPublicBaseUrl(): string {
  const explicit = (Deno.env.get("AGH_MCP_PLAYLIST_DISCOVERY_URL") || "").trim().replace(/\/$/, "");
  if (explicit) return explicit;
  const supabaseUrl = (Deno.env.get("SUPABASE_URL") || "").trim().replace(/\/$/, "");
  return `${supabaseUrl}/functions/v1/mcp-playlist-discovery`;
}

export function protectedResourceMetadata() {
  const base = mcpPublicBaseUrl();
  return {
    resource: `${base}/mcp`,
    authorization_servers: [base],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ["header"],
    resource_documentation: "https://github.com/fendifrost-dot/fan-growth-pilot",
  };
}

export function authorizationServerMetadata() {
  const base = mcpPublicBaseUrl();
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    scopes_supported: [SCOPE],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
  };
}

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function pkceS256Challenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return b64url(new Uint8Array(digest));
}

export async function registerClient(
  sb: SupabaseClient,
  body: Record<string, unknown>,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const redirectUris = Array.isArray(body.redirect_uris)
    ? body.redirect_uris.map(String)
    : [];
  if (!redirectUris.length) {
    return { status: 400, data: { error: "invalid_client_metadata", error_description: "redirect_uris required" } };
  }
  // Claude.ai callback must be accepted.
  const allowed = redirectUris.every((u) =>
    u.startsWith("https://claude.ai/") ||
    u.startsWith("https://claude.com/") ||
    u.startsWith("http://127.0.0.1:") ||
    u.startsWith("http://localhost:")
  );
  if (!allowed) {
    return { status: 400, data: { error: "invalid_redirect_uri" } };
  }
  const clientId = `agh-pd-${randomToken(8)}`;
  const clientSecret = randomToken(24);
  const secretHash = await sha256Hex(clientSecret);
  const { error } = await sb.from("agh_mcp_oauth_clients").insert({
    client_id: clientId,
    client_secret_hash: secretHash,
    client_name: body.client_name != null ? String(body.client_name) : "Claude Playlist Discovery",
    redirect_uris: redirectUris,
  });
  if (error) return { status: 500, data: { error: "server_error", error_description: error.message } };
  return {
    status: 201,
    data: {
      client_id: clientId,
      client_secret: clientSecret,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "client_secret_post",
      client_name: body.client_name ?? "Claude Playlist Discovery",
    },
  };
}

/**
 * Authorize: Fendi must present Bearer JWT matching ARTIST_USER_ID, OR the
 * one-time connector approval secret (CLAUDE_PLAYLIST_DISCOVERY_SECRET) as
 * x-agh-connector-approve — never the service-role key.
 */
export async function issueAuthCode(
  sb: SupabaseClient,
  opts: {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    codeChallengeMethod: string;
    scope: string;
    authorizedByUserId: string | null;
  },
): Promise<{ status: number; data: Record<string, unknown> }> {
  if (opts.codeChallengeMethod !== "S256") {
    return { status: 400, data: { error: "invalid_request", error_description: "S256 required" } };
  }
  if (opts.scope && opts.scope !== SCOPE) {
    return { status: 400, data: { error: "invalid_scope" } };
  }
  const { data: client } = await sb
    .from("agh_mcp_oauth_clients")
    .select("client_id, redirect_uris")
    .eq("client_id", opts.clientId)
    .maybeSingle();
  if (!client) return { status: 400, data: { error: "invalid_client" } };
  const uris = (client.redirect_uris as string[]) ?? [];
  if (!uris.includes(opts.redirectUri)) {
    return { status: 400, data: { error: "invalid_request", error_description: "redirect_uri mismatch" } };
  }
  const code = randomToken(24);
  const codeHash = await sha256Hex(code);
  const { error } = await sb.from("agh_mcp_oauth_codes").insert({
    code_hash: codeHash,
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    code_challenge: opts.codeChallenge,
    code_challenge_method: "S256",
    scope: SCOPE,
    authorized_by_user_id: opts.authorizedByUserId,
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  });
  if (error) return { status: 500, data: { error: "server_error", error_description: error.message } };
  return { status: 200, data: { code, redirect_uri: opts.redirectUri } };
}

export async function exchangeToken(
  sb: SupabaseClient,
  body: Record<string, unknown>,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const grant = String(body.grant_type ?? "");
  const clientId = String(body.client_id ?? "").trim();
  const clientSecret = body.client_secret != null ? String(body.client_secret) : "";

  const { data: client } = await sb
    .from("agh_mcp_oauth_clients")
    .select("*")
    .eq("client_id", clientId)
    .maybeSingle();
  if (!client) return { status: 401, data: { error: "invalid_client" } };
  if (client.client_secret_hash) {
    const hash = await sha256Hex(clientSecret);
    if (hash !== client.client_secret_hash) {
      return { status: 401, data: { error: "invalid_client" } };
    }
  }

  if (grant === "authorization_code") {
    const code = String(body.code ?? "");
    const redirectUri = String(body.redirect_uri ?? "");
    const verifier = String(body.code_verifier ?? "");
    if (!code || !verifier) {
      return { status: 400, data: { error: "invalid_request" } };
    }
    const codeHash = await sha256Hex(code);
    const { data: row } = await sb
      .from("agh_mcp_oauth_codes")
      .select("*")
      .eq("code_hash", codeHash)
      .maybeSingle();
    if (!row || new Date(String(row.expires_at)).getTime() < Date.now()) {
      return { status: 400, data: { error: "invalid_grant" } };
    }
    if (String(row.redirect_uri) !== redirectUri || String(row.client_id) !== clientId) {
      return { status: 400, data: { error: "invalid_grant" } };
    }
    const expected = await pkceS256Challenge(verifier);
    if (expected !== String(row.code_challenge)) {
      return { status: 400, data: { error: "invalid_grant", error_description: "pkce_failed" } };
    }
    await sb.from("agh_mcp_oauth_codes").delete().eq("code_hash", codeHash);
    return mintTokens(sb, {
      clientId,
      authorizedByUserId: row.authorized_by_user_id ? String(row.authorized_by_user_id) : null,
    });
  }

  if (grant === "refresh_token") {
    const refresh = String(body.refresh_token ?? "");
    const refreshHash = await sha256Hex(refresh);
    const { data: tok } = await sb
      .from("agh_mcp_oauth_tokens")
      .select("*")
      .eq("refresh_token_hash", refreshHash)
      .is("revoked_at", null)
      .maybeSingle();
    if (!tok || String(tok.client_id) !== clientId) {
      return { status: 400, data: { error: "invalid_grant" } };
    }
    await sb
      .from("agh_mcp_oauth_tokens")
      .update({ revoked_at: new Date().toISOString() })
      .eq("token_hash", tok.token_hash);
    return mintTokens(sb, {
      clientId,
      authorizedByUserId: tok.authorized_by_user_id ? String(tok.authorized_by_user_id) : null,
    });
  }

  return { status: 400, data: { error: "unsupported_grant_type" } };
}

async function mintTokens(
  sb: SupabaseClient,
  opts: { clientId: string; authorizedByUserId: string | null },
): Promise<{ status: number; data: Record<string, unknown> }> {
  const access = randomToken(32);
  const refresh = randomToken(32);
  const tokenHash = await sha256Hex(access);
  const refreshHash = await sha256Hex(refresh);
  const expiresIn = 3600;
  const { error } = await sb.from("agh_mcp_oauth_tokens").insert({
    token_hash: tokenHash,
    refresh_token_hash: refreshHash,
    client_id: opts.clientId,
    scope: SCOPE,
    actor_kind: ACTOR,
    authorized_by_user_id: opts.authorizedByUserId,
    expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
  });
  if (error) return { status: 500, data: { error: "server_error", error_description: error.message } };
  return {
    status: 200,
    data: {
      access_token: access,
      token_type: "bearer",
      expires_in: expiresIn,
      refresh_token: refresh,
      scope: SCOPE,
    },
  };
}

export async function resolveBearerActorKind(
  sb: SupabaseClient,
  authorizationHeader: string | null,
): Promise<{ ok: true; actorKind: typeof ACTOR } | { ok: false; error: string }> {
  if (!authorizationHeader?.toLowerCase().startsWith("bearer ")) {
    return { ok: false, error: "missing_bearer" };
  }
  const token = authorizationHeader.slice(7).trim();
  if (!token) return { ok: false, error: "missing_bearer" };
  const tokenHash = await sha256Hex(token);
  const { data } = await sb
    .from("agh_mcp_oauth_tokens")
    .select("actor_kind, expires_at, revoked_at")
    .eq("token_hash", tokenHash)
    .maybeSingle();
  if (!data || data.revoked_at) return { ok: false, error: "invalid_token" };
  if (new Date(String(data.expires_at)).getTime() < Date.now()) {
    return { ok: false, error: "token_expired" };
  }
  if (String(data.actor_kind) !== ACTOR) return { ok: false, error: "invalid_actor" };
  return { ok: true, actorKind: ACTOR };
}

export const PLAYLIST_DISCOVERY_SCOPE = SCOPE;
