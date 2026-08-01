// opportunities-api — the authenticated REST surface for the Opportunity Engine.
//
// AUTHORIZATION (a deliberate improvement over control-center-api's URL-secrecy):
// every request MUST carry a Supabase user JWT. Reads require any signed-in user;
// ALL mutations require the admin role (public.user_roles). The service-role key
// stays server-side only — the browser never holds it, and RLS denies direct
// PostgREST access to these tables, so this function is the sole gate.
//
// The deterministic engine logic is REUSED from the shared service layer in
// src/lib/opportunities (single source of truth across Vite / vitest / Deno).
//
// Deploy: redeploy via Lovable (standing rule). This file is the version-
// controlled source of truth.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  classifyRoute,
  createOpportunityRepository,
  decideAccess,
  type OppActor,
  parseResource,
} from "../../../src/lib/opportunities/index.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function bearer(req: Request): string {
  return (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
}

// deno-lint-ignore no-explicit-any
async function resolveActor(req: Request, admin: any): Promise<OppActor> {
  const token = bearer(req);
  if (!token) return { kind: "anonymous" };
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user) return { kind: "anonymous" };
  const { data: role } = await admin
    .from("user_roles")
    .select("role")
    .eq("user_id", data.user.id)
    .eq("role", "admin")
    .maybeSingle();
  return { kind: "user", userId: data.user.id, isAdmin: Boolean(role) };
}

function parseFilters(url: URL) {
  const p = url.searchParams;
  const num = (k: string) => (p.get(k) != null ? Number(p.get(k)) : undefined);
  return {
    filters: {
      status: p.get("status") ? p.get("status")!.split(",").map((s) => s.trim()) : undefined,
      opportunity_type: p.get("opportunity_type") ?? undefined,
      source_platform: p.get("source_platform") ?? undefined,
      entity_type: p.get("entity_type") ?? undefined,
      recommended_song_id: p.get("song") ?? p.get("recommended_song_id") ?? undefined,
      min_score: num("min_score"),
      max_risk: num("max_risk"),
      min_relationship: num("min_relationship"),
      discovered_after: p.get("discovered_after") ?? undefined,
      discovered_before: p.get("discovered_before") ?? undefined,
      search: p.get("search") ?? undefined,
    },
    opts: {
      limit: num("limit"),
      offset: num("offset"),
      order: (p.get("order") as "score" | "recent" | null) ?? undefined,
    },
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const url = new URL(req.url);
  const resource = parseResource(url.pathname);
  const method = req.method.toUpperCase();

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // ---- Authorize (JWT + role) -------------------------------------------
  const actor = await resolveActor(req, admin);
  const cls = classifyRoute(method, resource);
  const decision = decideAccess(cls, actor);
  if (!decision.ok) return json({ error: decision.error }, decision.status);

  const userId = actor.kind === "user" ? actor.userId : null;
  const repo = createOpportunityRepository(admin);

  try {
    const body = method === "GET" ? {} : await req.json().catch(() => ({}));
    const [head, id, sub] = resource; // e.g. opportunities / :id / approve

    // ---- Collection routes ---------------------------------------------
    if (head === "opportunities" && !id) {
      if (method === "GET") {
        const { filters, opts } = parseFilters(url);
        return json(await repo.listOpportunities(filters, opts));
      }
      if (method === "POST") {
        const result = await repo.createOpportunity(body);
        return json(result, result.created ? 201 : 200);
      }
    }

    if (head === "opportunities" && id === "stats" && method === "GET") {
      return json(await repo.stats());
    }

    if (head === "entities" && !id && method === "POST") {
      return json(await repo.findOrCreateEntity(body));
    }

    // ---- Item routes ----------------------------------------------------
    if (head === "opportunities" && id && !sub) {
      if (method === "GET") {
        const opp = await repo.getOpportunity(id);
        if (!opp) return json({ error: "Not found" }, 404);
        // Enrich with relationship summary for the entity.
        const relationship = opp.entity_id
          ? await repo.aggregateRelationshipForEntity(opp.entity_id)
          : null;
        return json({ opportunity: opp, relationship });
      }
      if (method === "PATCH") {
        return json(await repo.patchOpportunity(id, body));
      }
    }

    if (head === "opportunities" && id && sub && method === "POST") {
      const act = { userId, kind: "user" as const };
      switch (sub) {
        case "approve":
          return json(await repo.transition(id, "approved", act));
        case "reject":
          return json(await repo.transition(id, "rejected", act));
        case "snooze": {
          const until = body.snoozed_until ?? null;
          return json(await repo.transition(id, "snoozed", act, { snoozed_until: until }));
        }
        case "status": {
          // Generic advance for contacted / responded / converted / closed.
          if (!body.to) return json({ error: "Missing 'to' status" }, 400);
          return json(await repo.transition(id, body.to, act));
        }
        case "override-score": {
          if (body.manual_score == null) return json({ error: "Missing manual_score" }, 400);
          return json(
            await repo.overrideScore(id, Number(body.manual_score), String(body.reason ?? ""), act),
          );
        }
        case "record-outcome": {
          if (!body.outcome_type) return json({ error: "Missing outcome_type" }, 400);
          return json(await repo.recordOutcome(id, body, act));
        }
        case "generate-action":
          return json(await repo.generateAction(id, act));
        default:
          return json({ error: `Unknown action: ${sub}` }, 404);
      }
    }

    return json({ error: "Unknown route" }, 404);
  } catch (e) {
    const msg = (e as Error).message || "Internal error";
    // Illegal status transitions are a client error, not a 500.
    const status = /Illegal opportunity transition/.test(msg) ? 409 : 500;
    console.error("opportunities-api error:", msg);
    return json({ error: msg }, status);
  }
});
