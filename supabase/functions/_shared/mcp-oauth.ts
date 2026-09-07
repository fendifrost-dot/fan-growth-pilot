/**
 * OAuth 2.1 (PKCE S256) + Dynamic Client Registration for mcp-playlist-discovery.
 * Tokens always bind to claude_playlist_discovery.
 * Consent is Fendi-session-only (exact ARTIST_USER_ID) — never secret/JWT paste.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const SCOPE = "playlist_discovery";
const ACTOR = "claude_playlist_discovery";
/** Access token TTL (seconds). */
export const ACCESS_TOKEN_TTL_SEC = 3600;
/** Maximum refresh-token family lifetime. */
export const REFRESH_TOKEN_MAX_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

const APPROVED_REDIRECT_HOSTS = new Set([
  "claude.ai",
  "claude.com",
  "www.claude.ai",
  "www.claude.com",
]);

export function mcpPublicBaseUrl(): string {
  const explicit = (Deno.env.get("AGH_MCP_PLAYLIST_DISCOVERY_URL") || "").trim().replace(/\/$/, "");
  if (explicit) return explicit;
  const supabaseUrl = (Deno.env.get("SUPABASE_URL") || "").trim().replace(/\/$/, "");
  return `${supabaseUrl}/functions/v1/mcp-playlist-discovery`;
}

export function aghPublicAppUrl(): string {
  return (
    (Deno.env.get("AGH_PUBLIC_APP_URL") || "").trim().replace(/\/$/, "") ||
    (Deno.env.get("FRONTEND_URL") || "").trim().replace(/\/$/, "") ||
    "https://fan-growth-pilot.lovable.app"
  );
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
    revocation_endpoint: `${base}/oauth/revoke`,
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

/** Parse + exact-origin allowlist for OAuth redirect_uris. */
export function isAllowedRedirectUri(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (u.protocol === "https:") {
    if (APPROVED_REDIRECT_HOSTS.has(u.hostname)) return true;
    if (u.hostname.endsWith(".claude.ai") || u.hostname.endsWith(".claude.com")) return true;
    return false;
  }
  if (u.protocol === "http:") {
    return u.hostname === "127.0.0.1" || u.hostname === "localhost";
  }
  return false;
}

export async function registerClient(
  sb: SupabaseClient,
  body: Record<string, unknown>,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const redirectUris = Array.isArray(body.redirect_uris)
    ? body.redirect_uris.map(String)
    : [];
  if (!redirectUris.length) {
    return {
      status: 400,
      data: { error: "invalid_client_metadata", error_description: "redirect_uris required" },
    };
  }
  if (!redirectUris.every(isAllowedRedirectUri)) {
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
  if (error) {
    return { status: 500, data: { error: "server_error", error_description: error.message } };
  }
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
 * Authorize only via Fendi's Supabase-authenticated session JWT
 * (exact ARTIST_USER_ID). Never accepts connector secrets for consent.
 */
export async function authorizeFendiSession(
  sb: SupabaseClient,
  authorizationHeader: string | null,
): Promise<{ ok: true; userId: string } | { ok: false; error: string }> {
  if (!authorizationHeader?.toLowerCase().startsWith("bearer ")) {
    return { ok: false, error: "fendi_session_required" };
  }
  const token = authorizationHeader.slice(7).trim();
  if (!token) return { ok: false, error: "fendi_session_required" };
  const { data, error } = await sb.auth.getUser(token);
  if (error || !data?.user) return { ok: false, error: "invalid_session" };
  const fendiId = (Deno.env.get("ARTIST_USER_ID") || Deno.env.get("FENDI_USER_ID") || "").trim();
  if (!fendiId) return { ok: false, error: "artist_user_id_unconfigured" };
  if (data.user.id !== fendiId) {
    return { ok: false, error: "only_fendi_may_authorize_connector" };
  }
  return { ok: true, userId: data.user.id };
}

export async function issueAuthCode(
  sb: SupabaseClient,
  opts: {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    codeChallengeMethod: string;
    scope: string;
    authorizedByUserId: string;
  },
): Promise<{ status: number; data: Record<string, unknown> }> {
  if (opts.codeChallengeMethod !== "S256") {
    return { status: 400, data: { error: "invalid_request", error_description: "S256 required" } };
  }
  if (opts.scope && opts.scope !== SCOPE) {
    return { status: 400, data: { error: "invalid_scope" } };
  }
  if (!opts.authorizedByUserId) {
    return { status: 403, data: { error: "access_denied", error_description: "fendi_required" } };
  }
  if (!isAllowedRedirectUri(opts.redirectUri)) {
    return { status: 400, data: { error: "invalid_request", error_description: "redirect_uri not allowed" } };
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
  if (error) {
    return { status: 500, data: { error: "server_error", error_description: error.message } };
  }
  // Best-effort cleanup of expired rows on each authorize.
  await cleanupExpiredOAuthRecords(sb);
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
    const expectedChallenge = await pkceS256Challenge(verifier);
    const access = randomToken(32);
    const refresh = randomToken(32);
    const accessHash = await sha256Hex(access);
    const refreshHash = await sha256Hex(refresh);
    const accessExpires = new Date(Date.now() + ACCESS_TOKEN_TTL_SEC * 1000);
    const refreshExpires = new Date(Date.now() + REFRESH_TOKEN_MAX_LIFETIME_MS);

    const { data: rpcData, error: rpcErr } = await sb.rpc("agh_mcp_consume_oauth_code", {
      p_code_hash: codeHash,
      p_client_id: clientId,
      p_redirect_uri: redirectUri,
      p_expected_challenge: expectedChallenge,
      p_access_token_hash: accessHash,
      p_refresh_token_hash: refreshHash,
      p_access_expires_at: accessExpires.toISOString(),
      p_refresh_expires_at: refreshExpires.toISOString(),
    });
    if (rpcErr) {
      // Fallback when RPC not yet applied: non-atomic path (pre-migration).
      if (/could not find|does not exist|PGRST202/i.test(rpcErr.message)) {
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
        if (expectedChallenge !== String(row.code_challenge)) {
          return { status: 400, data: { error: "invalid_grant", error_description: "pkce_failed" } };
        }
        const { error: delErr, count } = await sb
          .from("agh_mcp_oauth_codes")
          .delete({ count: "exact" })
          .eq("code_hash", codeHash);
        if (delErr || count === 0) {
          return { status: 400, data: { error: "invalid_grant", error_description: "code already consumed" } };
        }
        return mintTokens(sb, {
          clientId,
          authorizedByUserId: row.authorized_by_user_id ? String(row.authorized_by_user_id) : null,
          refreshExpiresAt: refreshExpires,
          accessToken: access,
          refreshToken: refresh,
        });
      }
      return {
        status: 500,
        data: { error: "server_error", error_description: rpcErr.message },
      };
    }
    const result = (rpcData ?? {}) as Record<string, unknown>;
    if (!result.ok) {
      return {
        status: 400,
        data: {
          error: String(result.code ?? "invalid_grant"),
          error_description: String(result.error ?? "consume_failed"),
        },
      };
    }
    return {
      status: 200,
      data: {
        access_token: access,
        token_type: "bearer",
        expires_in: ACCESS_TOKEN_TTL_SEC,
        refresh_token: refresh,
        scope: SCOPE,
        refresh_expires_in: Math.floor(REFRESH_TOKEN_MAX_LIFETIME_MS / 1000),
      },
    };
  }

  if (grant === "refresh_token") {
    const refresh = String(body.refresh_token ?? "");
    const refreshHash = await sha256Hex(refresh);
    const access = randomToken(32);
    const newRefresh = randomToken(32);
    const accessHash = await sha256Hex(access);
    const newRefreshHash = await sha256Hex(newRefresh);
    const accessExpires = new Date(Date.now() + ACCESS_TOKEN_TTL_SEC * 1000);

    const { data: rpcData, error: rpcErr } = await sb.rpc("agh_mcp_rotate_oauth_refresh", {
      p_refresh_token_hash: refreshHash,
      p_client_id: clientId,
      p_new_access_token_hash: accessHash,
      p_new_refresh_token_hash: newRefreshHash,
      p_access_expires_at: accessExpires.toISOString(),
    });
    if (rpcErr) {
      if (/could not find|does not exist|PGRST202/i.test(rpcErr.message)) {
        const { data: tok } = await sb
          .from("agh_mcp_oauth_tokens")
          .select("*")
          .eq("refresh_token_hash", refreshHash)
          .is("revoked_at", null)
          .maybeSingle();
        if (!tok || String(tok.client_id) !== clientId) {
          return { status: 400, data: { error: "invalid_grant" } };
        }
        const refreshExp = tok.refresh_expires_at
          ? new Date(String(tok.refresh_expires_at)).getTime()
          : 0;
        if (!refreshExp || refreshExp < Date.now()) {
          await sb
            .from("agh_mcp_oauth_tokens")
            .update({ revoked_at: new Date().toISOString() })
            .eq("token_hash", tok.token_hash);
          return {
            status: 400,
            data: { error: "invalid_grant", error_description: "refresh_expired" },
          };
        }
        await sb
          .from("agh_mcp_oauth_tokens")
          .update({ revoked_at: new Date().toISOString() })
          .eq("token_hash", tok.token_hash);
        return mintTokens(sb, {
          clientId,
          authorizedByUserId: tok.authorized_by_user_id ? String(tok.authorized_by_user_id) : null,
          refreshExpiresAt: new Date(refreshExp),
          accessToken: access,
          refreshToken: newRefresh,
        });
      }
      return {
        status: 500,
        data: { error: "server_error", error_description: rpcErr.message },
      };
    }
    const result = (rpcData ?? {}) as Record<string, unknown>;
    if (!result.ok) {
      return {
        status: 400,
        data: {
          error: String(result.code ?? "invalid_grant"),
          error_description: String(result.error ?? "rotate_failed"),
        },
      };
    }
    const refreshExpAt = result.refresh_expires_at
      ? new Date(String(result.refresh_expires_at)).getTime()
      : Date.now();
    return {
      status: 200,
      data: {
        access_token: access,
        token_type: "bearer",
        expires_in: ACCESS_TOKEN_TTL_SEC,
        refresh_token: newRefresh,
        scope: SCOPE,
        refresh_expires_in: Math.max(0, Math.floor((refreshExpAt - Date.now()) / 1000)),
      },
    };
  }

  return { status: 400, data: { error: "unsupported_grant_type" } };
}

async function mintTokens(
  sb: SupabaseClient,
  opts: {
    clientId: string;
    authorizedByUserId: string | null;
    refreshExpiresAt: Date;
    accessToken?: string;
    refreshToken?: string;
  },
): Promise<{ status: number; data: Record<string, unknown> }> {
  const access = opts.accessToken ?? randomToken(32);
  const refresh = opts.refreshToken ?? randomToken(32);
  const tokenHash = await sha256Hex(access);
  const refreshHash = await sha256Hex(refresh);
  const { error } = await sb.from("agh_mcp_oauth_tokens").insert({
    token_hash: tokenHash,
    refresh_token_hash: refreshHash,
    client_id: opts.clientId,
    scope: SCOPE,
    actor_kind: ACTOR,
    authorized_by_user_id: opts.authorizedByUserId,
    expires_at: new Date(Date.now() + ACCESS_TOKEN_TTL_SEC * 1000).toISOString(),
    refresh_expires_at: opts.refreshExpiresAt.toISOString(),
  });
  if (error) {
    return { status: 500, data: { error: "server_error", error_description: error.message } };
  }
  return {
    status: 200,
    data: {
      access_token: access,
      token_type: "bearer",
      expires_in: ACCESS_TOKEN_TTL_SEC,
      refresh_token: refresh,
      scope: SCOPE,
      refresh_expires_in: Math.max(
        0,
        Math.floor((opts.refreshExpiresAt.getTime() - Date.now()) / 1000),
      ),
    },
  };
}

export async function revokeToken(
  sb: SupabaseClient,
  body: Record<string, unknown>,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const token = String(body.token ?? "").trim();
  if (!token) return { status: 400, data: { error: "invalid_request" } };
  const hash = await sha256Hex(token);
  const now = new Date().toISOString();
  await sb.from("agh_mcp_oauth_tokens").update({ revoked_at: now }).eq("token_hash", hash);
  await sb.from("agh_mcp_oauth_tokens").update({ revoked_at: now }).eq("refresh_token_hash", hash);
  return { status: 200, data: { revoked: true } };
}

export async function cleanupExpiredOAuthRecords(
  sb: SupabaseClient,
): Promise<{ codes_deleted?: number; tokens_deleted?: number }> {
  try {
    const { data } = await sb.rpc("agh_mcp_oauth_cleanup_expired");
    if (data && typeof data === "object") return data as Record<string, number>;
  } catch {
    // Fallback when RPC not yet applied: best-effort deletes.
  }
  await sb.from("agh_mcp_oauth_codes").delete().lt("expires_at", new Date().toISOString());
  return {};
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
    .select("actor_kind, expires_at, revoked_at, refresh_expires_at")
    .eq("token_hash", tokenHash)
    .maybeSingle();
  if (!data || data.revoked_at) return { ok: false, error: "invalid_token" };
  if (new Date(String(data.expires_at)).getTime() < Date.now()) {
    return { ok: false, error: "token_expired" };
  }
  if (String(data.actor_kind) !== ACTOR) return { ok: false, error: "invalid_actor" };
  return { ok: true, actorKind: ACTOR };
}

/** One-click Authorize/Cancel consent HTML — no credential inputs. */
export function renderConsentPage(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  aghAppUrl: string;
}): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const aghAuthorize = `${opts.aghAppUrl}/admin/mcp-playlist-authorize?` +
    new URLSearchParams({
      client_id: opts.clientId,
      redirect_uri: opts.redirectUri,
      state: opts.state,
      code_challenge: opts.codeChallenge,
      code_challenge_method: opts.codeChallengeMethod,
      scope: opts.scope,
    }).toString();

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>AGH · Authorize Playlist Discovery</title>
<style>
  body{font-family:ui-sans-serif,system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1.25rem;color:#111;background:#f7f5f2}
  h1{font-size:1.35rem;margin:0 0 .5rem}
  p{line-height:1.45;color:#333}
  .actions{display:flex;gap:.75rem;margin-top:1.5rem}
  button,.btn{appearance:none;border:0;border-radius:8px;padding:.7rem 1.1rem;font-size:1rem;cursor:pointer;text-decoration:none;display:inline-block}
  .authorize{background:#111;color:#fff}
  .cancel{background:#e8e4de;color:#222}
  .err{color:#8b1a1a;margin-top:1rem}
  .hint{font-size:.9rem;color:#555;margin-top:1.25rem}
</style></head>
<body>
<h1>Authorize Claude Playlist Discovery</h1>
<p>This grants Claude’s scheduled playlist-discovery connector the narrow <code>playlist_discovery</code> scope only. Approve/send and Song DNA remain with Grok / Fendi.</p>
<p>Sign-in uses your existing AGH session. Only Fendi may authorize.</p>
<div class="actions">
  <button type="button" class="authorize" id="authorize">Authorize</button>
  <button type="button" class="cancel" id="cancel">Cancel</button>
</div>
<p class="err" id="err" hidden></p>
<p class="hint">If you are not signed in here, continue in AGH Admin:<br/>
<a class="btn cancel" href="${esc(aghAuthorize)}">Open AGH authorize</a></p>
<script type="module">
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
const params = {
  client_id: ${JSON.stringify(opts.clientId)},
  redirect_uri: ${JSON.stringify(opts.redirectUri)},
  state: ${JSON.stringify(opts.state)},
  code_challenge: ${JSON.stringify(opts.codeChallenge)},
  code_challenge_method: ${JSON.stringify(opts.codeChallengeMethod || "S256")},
  scope: ${JSON.stringify(opts.scope)},
  decision: "authorize",
};
const errEl = document.getElementById("err");
function showErr(m){ errEl.hidden=false; errEl.textContent=m; }
document.getElementById("cancel").onclick = () => {
  const u = new URL(params.redirect_uri);
  u.searchParams.set("error", "access_denied");
  if (params.state) u.searchParams.set("state", params.state);
  location.href = u.toString();
};
document.getElementById("authorize").onclick = async () => {
  try {
    const sb = createClient(${JSON.stringify(opts.supabaseUrl)}, ${JSON.stringify(opts.supabaseAnonKey)});
    const { data: { session } } = await sb.auth.getSession();
    if (!session?.access_token) {
      location.href = ${JSON.stringify(aghAuthorize)};
      return;
    }
    const res = await fetch(location.pathname + location.search, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": "Bearer " + session.access_token,
      },
      body: JSON.stringify(params),
    });
    if (res.redirected) { location.href = res.url; return; }
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      const j = await res.json();
      if (j.redirect_to) { location.href = j.redirect_to; return; }
      showErr(j.error_description || j.error || ("HTTP " + res.status));
      return;
    }
    if (res.ok) { location.href = res.url || location.href; return; }
    showErr("Authorization failed (" + res.status + ")");
  } catch (e) {
    showErr(String(e?.message || e));
  }
};
</script>
</body></html>`;
}

export const PLAYLIST_DISCOVERY_SCOPE = SCOPE;
