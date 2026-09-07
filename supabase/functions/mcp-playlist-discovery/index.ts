/**
 * Remote MCP endpoint for Claude playlist discovery (custom connector / Cowork).
 *
 * Transport: Streamable HTTP JSON-RPC at /mcp
 * Auth: OAuth 2.1 + PKCE (S256) + Dynamic Client Registration
 *
 * All tools run as fixed identity claude_playlist_discovery.
 * Never exposes SUPABASE_SERVICE_ROLE_KEY. Never accepts arbitrary action names.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  authorizationServerMetadata,
  exchangeToken,
  issueAuthCode,
  mcpPublicBaseUrl,
  PLAYLIST_DISCOVERY_SCOPE,
  protectedResourceMetadata,
  registerClient,
  resolveBearerActorKind,
} from "../_shared/mcp-oauth.ts";
import {
  PLAYLIST_DISCOVERY_TOOLS,
  playlistDiscoveryActor,
  runPlaylistDiscoveryTool,
} from "../_shared/playlist-discovery-mcp.ts";
import { secretsEqual } from "../_shared/ops-actors.ts";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, content-type, mcp-session-id, x-claude-playlist-discovery-secret, x-agh-connector-approve",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", ...extra },
  });
}

function html(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { ...corsHeaders, "Content-Type": "text/html; charset=utf-8" },
  });
}

function sbAdmin() {
  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return createClient(url, key);
}

function pathOf(req: Request): string {
  const u = new URL(req.url);
  // Strip function prefix if present
  let p = u.pathname;
  const marker = "/mcp-playlist-discovery";
  const idx = p.indexOf(marker);
  if (idx >= 0) p = p.slice(idx + marker.length) || "/";
  if (!p.startsWith("/")) p = `/${p}`;
  return p;
}

async function authorizeFendiOrConnectorSecret(
  req: Request,
  sb: ReturnType<typeof sbAdmin>,
): Promise<{ ok: true; userId: string | null } | { ok: false; error: string }> {
  // Path A: connector approval secret (one-time Fendi paste — not service-role, not broad Claude).
  const approve =
    req.headers.get("x-agh-connector-approve") ||
    req.headers.get("x-claude-playlist-discovery-secret") ||
    "";
  const discoverySecret = (Deno.env.get("CLAUDE_PLAYLIST_DISCOVERY_SECRET") || "").trim();
  if (discoverySecret && approve && secretsEqual(approve.trim(), discoverySecret)) {
    return { ok: true, userId: null };
  }

  // Path B: Fendi JWT (exact ARTIST_USER_ID).
  const auth = req.headers.get("authorization") || "";
  if (!auth.toLowerCase().startsWith("bearer ")) {
    return { ok: false, error: "Fendi JWT or connector approval secret required" };
  }
  const token = auth.slice(7).trim();
  const { data, error } = await sb.auth.getUser(token);
  if (error || !data?.user) return { ok: false, error: "invalid_jwt" };
  const fendiId = (Deno.env.get("ARTIST_USER_ID") || Deno.env.get("FENDI_USER_ID") || "").trim();
  if (!fendiId || data.user.id !== fendiId) {
    return { ok: false, error: "only_fendi_may_authorize_connector" };
  }
  return { ok: true, userId: data.user.id };
}

const TOOL_DEFS = PLAYLIST_DISCOVERY_TOOLS.map((name) => ({
  name,
  description: toolDescription(name),
  inputSchema: { type: "object", additionalProperties: true },
}));

function toolDescription(name: string): string {
  switch (name) {
    case "get_playlist_discovery_work":
      return "Read active pitching tracks (ids/titles), current approved DNA, lanes, profiles, daily target. No ISRCs.";
    case "submit_playlist_candidates":
      return "Submit structured playlist candidate facts + evidence. Server dedupes, verifies, enforces DNA lanes.";
    case "create_playlist_draft_inventory":
      return "Create Claude-side pending draft/handoff inventory from accepted candidate IDs. No approve/send. No caller pitch copy.";
    case "start_claude_playlist_station":
      return "Start a Claude-owned playlist discovery station run.";
    case "complete_claude_playlist_station":
      return "Complete a Claude-owned playlist discovery station run.";
    case "get_own_playlist_batches":
      return "List handoff batches attributed to claude_playlist_discovery only.";
    default:
      return name;
  }
}

async function handleMcp(
  req: Request,
  sb: ReturnType<typeof sbAdmin>,
): Promise<Response> {
  const authz = req.headers.get("authorization");
  const bearer = await resolveBearerActorKind(sb, authz);
  if (!bearer.ok) {
    const base = mcpPublicBaseUrl();
    return json(401, { error: "unauthorized", error_description: bearer.error }, {
      "WWW-Authenticate":
        `Bearer realm="agh-playlist-discovery", resource_metadata="${base}/.well-known/oauth-protected-resource"`,
    });
  }

  if (req.method === "GET") {
    // Streamable HTTP: optional SSE open; return 405 with Allow for simple clients.
    return json(200, {
      ok: true,
      transport: "streamable-http",
      tools: PLAYLIST_DISCOVERY_TOOLS,
      actor: "claude_playlist_discovery",
    });
  }

  let rpc: Record<string, unknown>;
  try {
    rpc = await req.json();
  } catch {
    return json(400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
  }

  const id = rpc.id ?? null;
  const method = String(rpc.method ?? "");
  const params = (typeof rpc.params === "object" && rpc.params
    ? rpc.params
    : {}) as Record<string, unknown>;

  const ops = playlistDiscoveryActor();

  if (method === "initialize") {
    return json(200, {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "agh-playlist-discovery", version: "1.0.0" },
      },
    });
  }
  if (method === "notifications/initialized" || method === "ping") {
    return json(200, { jsonrpc: "2.0", id, result: {} });
  }
  if (method === "tools/list") {
    return json(200, { jsonrpc: "2.0", id, result: { tools: TOOL_DEFS } });
  }
  if (method === "tools/call") {
    const name = String(params.name ?? "");
    const args = (typeof params.arguments === "object" && params.arguments
      ? params.arguments
      : {}) as Record<string, unknown>;
    // Fail closed on unknown tools — never forward arbitrary CCA action names.
    const result = await runPlaylistDiscoveryTool(name, args, sb, ops);
    if (result.status >= 400) {
      return json(200, {
        jsonrpc: "2.0",
        id,
        result: {
          isError: true,
          content: [{ type: "text", text: JSON.stringify(result.data) }],
        },
      });
    }
    return json(200, {
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: JSON.stringify(result.data) }],
      },
    });
  }

  return json(200, {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const path = pathOf(req);
  const sb = sbAdmin();

  try {
    // ---- OAuth discovery ----
    if (
      path === "/.well-known/oauth-protected-resource" ||
      path === "/.well-known/oauth-protected-resource/mcp"
    ) {
      return json(200, protectedResourceMetadata());
    }
    if (
      path === "/.well-known/oauth-authorization-server" ||
      path === "/.well-known/openid-configuration"
    ) {
      return json(200, authorizationServerMetadata());
    }

    // ---- Health (no secrets) ----
    if (path === "/health" || path === "/") {
      return json(200, {
        ok: true,
        service: "mcp-playlist-discovery",
        actor: "claude_playlist_discovery",
        tools: PLAYLIST_DISCOVERY_TOOLS,
        oauth: true,
        mcp: `${mcpPublicBaseUrl()}/mcp`,
      });
    }

    // ---- DCR ----
    if (path === "/oauth/register" && req.method === "POST") {
      const body = await req.json();
      const result = await registerClient(sb, body);
      return json(result.status, result.data);
    }

    // ---- Authorize (Fendi JWT or connector approval secret) ----
    if (path === "/oauth/authorize") {
      const url = new URL(req.url);
      if (req.method === "GET") {
        // Simple consent page — Fendi completes with Authorization header via form POST
        // or connector secret. No service-role exposure.
        const clientId = url.searchParams.get("client_id") || "";
        const redirectUri = url.searchParams.get("redirect_uri") || "";
        const state = url.searchParams.get("state") || "";
        const challenge = url.searchParams.get("code_challenge") || "";
        const method = url.searchParams.get("code_challenge_method") || "S256";
        const scope = url.searchParams.get("scope") || PLAYLIST_DISCOVERY_SCOPE;
        return html(
          200,
          `<!doctype html><html><head><title>AGH Playlist Discovery — Authorize</title></head>
<body style="font-family:system-ui;max-width:40rem;margin:2rem auto">
<h1>Authorize Claude Playlist Discovery</h1>
<p>Only Fendi may approve this connector. Paste your Fendi session Bearer token <em>or</em> the
<code>CLAUDE_PLAYLIST_DISCOVERY_SECRET</code> connector approval value (never the service-role key).</p>
<form method="POST" action="">
<input type="hidden" name="client_id" value="${clientId.replace(/"/g, "")}"/>
<input type="hidden" name="redirect_uri" value="${redirectUri.replace(/"/g, "")}"/>
<input type="hidden" name="state" value="${state.replace(/"/g, "")}"/>
<input type="hidden" name="code_challenge" value="${challenge.replace(/"/g, "")}"/>
<input type="hidden" name="code_challenge_method" value="${method.replace(/"/g, "")}"/>
<input type="hidden" name="scope" value="${scope.replace(/"/g, "")}"/>
<label>Approval credential<br/><input name="approval" style="width:100%" autocomplete="off"/></label>
<p><button type="submit">Authorize playlist_discovery scope</button></p>
</form>
</body></html>`,
        );
      }
      if (req.method === "POST") {
        const ct = req.headers.get("content-type") || "";
        let fields: Record<string, string> = {};
        if (ct.includes("application/json")) {
          const body = await req.json();
          fields = Object.fromEntries(Object.entries(body).map(([k, v]) => [k, String(v ?? "")]));
        } else {
          const form = await req.formData();
          form.forEach((v, k) => {
            fields[k] = String(v);
          });
        }
        const approval = fields.approval || "";
        const synthetic = new Request(req.url, {
          headers: {
            authorization: approval.toLowerCase().startsWith("bearer ")
              ? approval
              : `Bearer ${approval}`,
            "x-agh-connector-approve": approval,
          },
        });
        // Prefer connector secret header path when token isn't a JWT.
        const authz = await authorizeFendiOrConnectorSecret(
          new Request(req.url, {
            headers: {
              "x-agh-connector-approve": approval,
              authorization: approval.toLowerCase().startsWith("bearer ")
                ? approval
                : "",
            },
          }),
          sb,
        );
        void synthetic;
        if (!authz.ok) return json(403, { error: authz.error });
        const issued = await issueAuthCode(sb, {
          clientId: fields.client_id,
          redirectUri: fields.redirect_uri,
          codeChallenge: fields.code_challenge,
          codeChallengeMethod: fields.code_challenge_method || "S256",
          scope: fields.scope || PLAYLIST_DISCOVERY_SCOPE,
          authorizedByUserId: authz.userId,
        });
        if (issued.status !== 200) return json(issued.status, issued.data);
        const redirect = new URL(fields.redirect_uri);
        redirect.searchParams.set("code", String(issued.data.code));
        if (fields.state) redirect.searchParams.set("state", fields.state);
        return Response.redirect(redirect.toString(), 302);
      }
    }

    if (path === "/oauth/token" && req.method === "POST") {
      const ct = req.headers.get("content-type") || "";
      let body: Record<string, unknown> = {};
      if (ct.includes("application/json")) body = await req.json();
      else {
        const form = await req.formData();
        form.forEach((v, k) => {
          body[k] = String(v);
        });
      }
      const result = await exchangeToken(sb, body);
      return json(result.status, result.data);
    }

    // ---- MCP ----
    if (path === "/mcp") {
      return handleMcp(req, sb);
    }

    return json(404, { error: "not_found", path });
  } catch (e) {
    return json(500, { error: "server_error", message: String((e as Error).message || e) });
  }
});
