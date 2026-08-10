// opportunities-api — the authenticated REST surface for the Opportunity Engine.
//
// AUTHORIZATION (a deliberate improvement over control-center-api's URL-secrecy):
// every request MUST carry a Supabase user JWT. Reads require any signed-in user;
// ALL mutations require the admin role (public.user_roles). The service-role key
// stays server-side only — the browser never holds it, and RLS denies direct
// PostgREST access to these tables, so this function is the sole gate.
//
// The deterministic engine logic is REUSED from the shared service layer in
// supabase/functions/_shared/opportunities (single source of truth; src/lib/
// opportunities re-exports the same physical modules for Vite / vitest).
//
// Deploy: redeploy via Lovable (standing rule). This file is the version-
// controlled source of truth.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  classifyRoute,
  createOpportunityRepository,
  decideAccess,
  isOpportunityRequestError,
  type OppActor,
  parseResource,
  validateConversationInput,
  validateCreateOpportunityInput,
  validateInteractionInput,
  validateInteractionStatusUpdate,
} from "../_shared/opportunities/index.ts";

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
  const num = (k: string) => {
    const v = p.get(k);
    if (v == null) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined; // drop non-numeric params rather than passing NaN
  };
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

  try {
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

    const body = method === "GET" ? {} : await req.json().catch(() => ({}));
    const [head, id, sub] = resource; // e.g. opportunities / :id / approve

    // ---- Collection routes ---------------------------------------------
    if (head === "opportunities" && !id) {
      if (method === "GET") {
        const { filters, opts } = parseFilters(url);
        return json(await repo.listOpportunities(filters, opts));
      }
      if (method === "POST") {
        // Validate the FULL request boundary BEFORE any DB write so malformed input
        // returns a clean 4xx instead of an opaque 500 from a downstream NOT NULL /
        // FK / uuid-cast / CHECK violation. Pure shape/range/UUID/clip checks first,
        // then the DB-dependent reference + duration checks.
        const input = validateCreateOpportunityInput(body);
        await repo.assertCreatableReferences(input);
        const result = await repo.createOpportunity(input);
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

    // ---- Conversations (business relationship threads) -----------------
    // GET is any signed-in user (authenticated-read); POST is admin-write —
    // both enforced above by classifyRoute/decideAccess before we get here.
    if (head === "conversations" && !id) {
      if (method === "GET") {
        const p = url.searchParams;
        return json(await repo.listConversations({
          entity_id: p.get("entity_id") ?? undefined,
          opportunity_id: p.get("opportunity_id") ?? undefined,
          status: p.get("status") ?? undefined,
        }));
      }
      if (method === "POST") {
        // find-or-create: 201 when a new thread is minted, 200 when reused.
        const input = validateConversationInput(body);
        const result = await repo.findOrCreateConversation(input);
        return json(result, result.created ? 201 : 200);
      }
    }

    if (head === "conversations" && id && !sub && method === "GET") {
      const conv = await repo.getConversation(id);
      if (!conv) return json({ error: "Not found" }, 404);
      return json({ conversation: conv });
    }

    // ---- Interactions (one polymorphic touch inside a conversation) -----
    if (head === "interactions" && !id) {
      if (method === "GET") {
        const p = url.searchParams;
        // Attribution lookup: ?smart_link=<slug|short_code> resolves a click back
        // to the interaction(s) — and thus opportunity — the link was attached to.
        const smartLink = p.get("smart_link");
        if (smartLink) return json(await repo.findInteractionsBySmartLink(smartLink));
        return json(await repo.listInteractions({
          conversation_id: p.get("conversation_id") ?? undefined,
          opportunity_id: p.get("opportunity_id") ?? undefined,
          entity_id: p.get("entity_id") ?? undefined,
        }));
      }
      if (method === "POST") {
        // Record a PROPOSED touch (default status) associated with its
        // conversation + entity/contact + opportunity. 201 only for a newly-
        // created interaction; a deduped/replayed touch returns 200 so a
        // scheduled operator can distinguish creation from replay.
        const input = validateInteractionInput(body);
        const result = await repo.recordInteraction(input);
        return json(result, result.created ? 201 : 200);
      }
    }

    if (head === "interactions" && id && !sub) {
      if (method === "GET") {
        const it = await repo.getInteraction(id);
        if (!it) return json({ error: "Not found" }, 404);
        return json({ interaction: it });
      }
      if (method === "PATCH") {
        // Advance the touch's lifecycle status after a human action.
        const patch = validateInteractionStatusUpdate(body);
        return json(await repo.updateInteractionStatus(id, patch));
      }
    }

    return json({ error: "Unknown route" }, 404);
  } catch (e) {
    // Request-boundary validation errors carry an explicit HTTP status and a
    // client-safe message (no DB internals) — return them as clean 4xx.
    if (isOpportunityRequestError(e)) return json({ error: e.message }, e.status);
    const msg = (e as Error).message || "Internal error";
    // Log the full detail SERVER-SIDE only; never return DB internals to the client.
    console.error("opportunities-api error:", msg);
    if (/Illegal opportunity transition/.test(msg)) {
      return json({ error: "Illegal status transition" }, 409);
    }
    if (/not found/i.test(msg)) return json({ error: "Not found" }, 404);
    return json({ error: "Internal error" }, 500);
  }
});
