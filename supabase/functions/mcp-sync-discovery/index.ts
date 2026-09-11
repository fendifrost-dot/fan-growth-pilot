/**
 * Remote MCP endpoint for Claude sync discovery (custom connector / Cowork).
 *
 * Transport: Streamable HTTP JSON-RPC at /mcp
 * Auth: OAuth 2.1 + PKCE (S256) + Dynamic Client Registration
 *
 * Consent: Fendi's existing Supabase AGH session (exact ARTIST_USER_ID) only.
 * Never accepts pasted JWT or CLAUDE_SYNC_DISCOVERY_SECRET for OAuth.
 *
 * All tools run as fixed identity claude_sync_discovery.
 * Never exposes SUPABASE_SERVICE_ROLE_KEY. Never accepts arbitrary action names.
 * Never approves/sends outreach or mutates Song DNA / eligibility.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  aghPublicAppUrl,
  authorizeFendiSession,
  exchangeToken,
  issueAuthCode,
  registerClient,
  renderConsentPage,
  resolveBearerActorKind,
  revokeToken,
  SYNC_DISCOVERY_SCOPE,
  syncAuthorizationServerMetadata,
  syncMcpPublicBaseUrl,
  syncProtectedResourceMetadata,
} from "../_shared/mcp-oauth.ts";
import {
  SYNC_DISCOVERY_TOOLS,
  SYNC_DISCOVERY_TOOL_SCHEMAS,
  syncDiscoveryActor,
  runSyncDiscoveryTool,
} from "../_shared/sync-discovery-mcp.ts";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, content-type, mcp-session-id",
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
  let p = u.pathname;
  const marker = "/mcp-sync-discovery";
  const idx = p.indexOf(marker);
  if (idx >= 0) p = p.slice(idx + marker.length) || "/";
  if (!p.startsWith("/")) p = `/${p}`;
  return p;
}

function toolDescription(name: string): string {
  switch (name) {
    case "get_sync_discovery_work":
      return "Read active sync-research tracks from AGH config + approved Song DNA + server eligibility. Never invent eligibility.";
    case "submit_sync_targets":
      return "Persist researched sync targets (agency contacts). Idempotent dedupe. Attribution from auth identity only.";
    case "submit_sync_opportunities":
      return "Persist active_brief (requires deadline) or agency_introduction records with provenance.";
    case "create_sync_drafts":
      return "Create pending catered sync drafts only when server eligibility passes. Returns precise blockers otherwise.";
    case "verify_sync_contacts":
      return "Verify contact routes + evidence for own sync targets.";
    case "advance_sync_batch":
      return "Create durable sync handoff batch for Grok review. Persists counts + record IDs in AGH.";
    case "start_claude_sync_station":
      return "Start the noon sync_batch_ready station run.";
    case "complete_claude_sync_station":
      return "Complete the noon sync_batch_ready station run with honest shortfalls.";
    case "get_own_sync_batches":
      return "List sync handoff batches attributed to claude_sync_discovery only.";
    default:
      return name;
  }
}

const TOOL_DEFS = SYNC_DISCOVERY_TOOLS.map((name) => ({
  name,
  description: toolDescription(name),
  inputSchema: SYNC_DISCOVERY_TOOL_SCHEMAS[name],
}));

async function handleMcp(
  req: Request,
  sb: ReturnType<typeof sbAdmin>,
): Promise<Response> {
  const authz = req.headers.get("authorization");
  const bearer = await resolveBearerActorKind(sb, authz, "claude_sync_discovery");
  if (!bearer.ok) {
    const base = syncMcpPublicBaseUrl();
    return json(401, { error: "unauthorized", error_description: bearer.error }, {
      "WWW-Authenticate":
        `Bearer realm="agh-sync-discovery", resource_metadata="${base}/.well-known/oauth-protected-resource"`,
    });
  }

  if (req.method === "GET") {
    return json(200, {
      ok: true,
      transport: "streamable-http",
      tools: SYNC_DISCOVERY_TOOLS,
      actor: "claude_sync_discovery",
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

  const ops = syncDiscoveryActor();

  if (method === "initialize") {
    return json(200, {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "agh-sync-discovery", version: "1.0.0" },
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
    const result = await runSyncDiscoveryTool(name, args, sb, ops);
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
    if (
      path === "/.well-known/oauth-protected-resource" ||
      path === "/.well-known/oauth-protected-resource/mcp"
    ) {
      return json(200, syncProtectedResourceMetadata());
    }
    if (
      path === "/.well-known/oauth-authorization-server" ||
      path === "/.well-known/openid-configuration"
    ) {
      return json(200, syncAuthorizationServerMetadata());
    }

    if (path === "/health" || path === "/") {
      return json(200, {
        ok: true,
        service: "mcp-sync-discovery",
        actor: "claude_sync_discovery",
        tools: SYNC_DISCOVERY_TOOLS,
        oauth: true,
        consent: "fendi_session_only",
        mcp: `${syncMcpPublicBaseUrl()}/mcp`,
      });
    }

    if (path === "/oauth/register" && req.method === "POST") {
      const body = await req.json();
      const result = await registerClient(sb, {
        ...body,
        client_name: body.client_name ?? "Claude Sync Discovery",
      });
      return json(result.status, result.data);
    }

    if (path === "/oauth/revoke" && req.method === "POST") {
      const ct = req.headers.get("content-type") || "";
      let body: Record<string, unknown> = {};
      if (ct.includes("application/json")) body = await req.json();
      else {
        const form = await req.formData();
        form.forEach((v, k) => {
          body[k] = String(v);
        });
      }
      const result = await revokeToken(sb, body);
      return json(result.status, result.data);
    }

    if (path === "/oauth/authorize") {
      const url = new URL(req.url);
      if (req.method === "GET") {
        const clientId = url.searchParams.get("client_id") || "";
        const redirectUri = url.searchParams.get("redirect_uri") || "";
        const state = url.searchParams.get("state") || "";
        const challenge = url.searchParams.get("code_challenge") || "";
        const method = url.searchParams.get("code_challenge_method") || "S256";
        const scope = url.searchParams.get("scope") || SYNC_DISCOVERY_SCOPE;
        const supabaseUrl = (Deno.env.get("SUPABASE_URL") || "").trim();
        const anonKey = (
          Deno.env.get("SUPABASE_ANON_KEY") ||
          Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ||
          ""
        ).trim();
        return html(
          200,
          renderConsentPage({
            clientId,
            redirectUri,
            state,
            codeChallenge: challenge,
            codeChallengeMethod: method,
            scope,
            supabaseUrl,
            supabaseAnonKey: anonKey,
            aghAppUrl: aghPublicAppUrl(),
            connector: "sync",
          }),
        );
      }
      if (req.method === "POST") {
        const ct = req.headers.get("content-type") || "";
        let fields: Record<string, string> = {};
        if (ct.includes("application/json")) {
          const body = await req.json();
          fields = Object.fromEntries(
            Object.entries(body).map(([k, v]) => [k, String(v ?? "")]),
          );
        } else {
          const form = await req.formData();
          form.forEach((v, k) => {
            fields[k] = String(v);
          });
        }

        if (fields.decision === "cancel") {
          const redirect = new URL(fields.redirect_uri);
          redirect.searchParams.set("error", "access_denied");
          if (fields.state) redirect.searchParams.set("state", fields.state);
          return json(200, { redirect_to: redirect.toString() });
        }

        const authz = await authorizeFendiSession(sb, req.headers.get("authorization"));
        if (!authz.ok) return json(403, { error: authz.error });

        const issued = await issueAuthCode(sb, {
          clientId: fields.client_id,
          redirectUri: fields.redirect_uri,
          codeChallenge: fields.code_challenge,
          codeChallengeMethod: fields.code_challenge_method || "S256",
          scope: fields.scope || SYNC_DISCOVERY_SCOPE,
          authorizedByUserId: authz.userId,
        });
        if (issued.status !== 200) return json(issued.status, issued.data);
        const redirect = new URL(fields.redirect_uri);
        redirect.searchParams.set("code", String(issued.data.code));
        if (fields.state) redirect.searchParams.set("state", fields.state);
        if (ct.includes("application/json")) {
          return json(200, { redirect_to: redirect.toString(), code: issued.data.code });
        }
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

    if (path === "/mcp") {
      return handleMcp(req, sb);
    }

    return json(404, { error: "not_found", path });
  } catch (e) {
    return json(500, { error: "server_error", message: String((e as Error).message || e) });
  }
});
