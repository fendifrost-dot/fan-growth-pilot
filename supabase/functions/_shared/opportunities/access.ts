// Opportunity Engine — pure authorization decision for the API.
//
// Kept separate from the Deno Edge Function so it is unit-testable under vitest
// (the DoD "RLS-sensitive routes" test). The Edge Function imports these and
// enforces them; PostgREST direct access is already denied by RLS, so this is the
// single place callers are authorized.
//
// Model (mirrors the proven _shared/outreach-auth.ts classes):
//   authenticated-read  any signed-in user (reads)
//   admin-write         admin role only (any mutation)

export type OppAuthClass = "authenticated-read" | "admin-write";

export type OppActor =
  | { kind: "user"; userId: string; isAdmin: boolean }
  | { kind: "anonymous" };

export interface OppRoute {
  cls: OppAuthClass;
  /** Parsed for the handler: the resource segments after the function name. */
  resource: string[];
}

export interface OppAccessDecision {
  ok: boolean;
  status: number;
  error?: string;
}

/**
 * Classify a request by method + path. Everything that is not a GET is a mutation
 * and requires admin. Unknown paths are still classified (the handler 404s on an
 * unknown resource) but never silently downgraded to anonymous.
 */
export function classifyRoute(method: string, resource: string[]): OppAuthClass {
  return method.toUpperCase() === "GET" ? "authenticated-read" : "admin-write";
}

export function decideAccess(cls: OppAuthClass, actor: OppActor): OppAccessDecision {
  if (actor.kind === "anonymous") {
    return { ok: false, status: 401, error: "Sign-in required" };
  }
  if (cls === "admin-write" && !actor.isAdmin) {
    return { ok: false, status: 403, error: "Admin role required" };
  }
  return { ok: true, status: 200 };
}

/**
 * Strip the Supabase function prefix from a pathname and return the resource
 * segments. e.g. "/functions/v1/opportunities-api/opportunities/abc/approve"
 * -> ["opportunities", "abc", "approve"].
 */
export function parseResource(pathname: string, fnName = "opportunities-api"): string[] {
  const parts = pathname.split("/").filter(Boolean);
  const idx = parts.indexOf(fnName);
  return idx >= 0 ? parts.slice(idx + 1) : parts;
}
