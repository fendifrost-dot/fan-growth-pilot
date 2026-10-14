/**
 * Durable log of rejected and deferred server-side route fetches.
 *
 * A login wall, paywall, captcha, dead form, follow gate, closed submissions,
 * SSRF refusal, timeout, 5xx, or DNS failure does not become a playlist target.
 * The fetch result is still stored so it can be queried and so the same route
 * is not fetched again while the result is fresh.
 *
 * Rows contain the playlist id, the normalized route URL, a failure code, the
 * HTTP status, fetched_at, and a short summary. No page body, no curator email,
 * no account handle, and no URL userinfo or tracking parameters.
 */
import {
  blockingSignal,
  emptySignals,
  fetchRoutePage,
  isDeferredFetch,
  type RouteFetchDeps,
  type RouteFetchErrorClass,
  type RoutePage,
} from "./route-fetch.ts";

export const ROUTE_FETCH_OUTCOMES_TABLE = "agh_route_fetch_outcomes";
/** Structural rejections are stable enough that a same-route refetch inside a week is needless. */
export const ROUTE_REJECTION_SKIP_MS = 7 * 24 * 60 * 60 * 1000;
/** Matches the temporary-host retry window. */
export const ROUTE_DEFER_SKIP_MS = 30 * 60 * 1000;

const SUMMARY_MAX = 240;
const URL_MAX = 2000;
const PLAYLIST_ID_MAX = 200;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const TRACKING_PARAM = /^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$|si$|ref$|ref_src$)/i;
const PHONE_RE = /\d{3}[-.\s]?\d{3}[-.\s]?\d{4}/;

const DEFERRED_CODES = new Set(["timeout", "dns", "http_5xx", "network", "too_many_redirects"]);

export type RouteFetchLogClient = {
  // deno-lint-ignore no-explicit-any
  from: (table: string) => any;
};

export type RouteFetchLogDecision = {
  disposition: "rejected" | "deferred";
  failureCode: string;
};

/** Lookup key for a submission route. Null when the URL is not http(s). */
export function routeUrlKey(raw: string | null | undefined): string | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.protocol === "http:") u.protocol = "https:";
  u.username = "";
  u.password = "";
  u.hash = "";
  u.hostname = u.hostname.toLowerCase().replace(/\.$/, "");
  for (const key of [...u.searchParams.keys()]) {
    const val = u.searchParams.get(key) ?? "";
    if (TRACKING_PARAM.test(key) || val.includes("@") || PHONE_RE.test(val)) {
      u.searchParams.delete(key);
    }
  }
  u.searchParams.sort();
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "");
  const href = u.toString();
  return href.length > URL_MAX ? href.slice(0, URL_MAX) : href;
}

/** Short classifier note. Titles are kept; emails and page bodies are not. */
export function routeEvidenceSummary(page: RoutePage, failureCode: string): string {
  const title = (page.title ?? "")
    .replace(EMAIL_RE, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  const parts = [failureCode];
  if (page.status != null && Number.isFinite(page.status)) parts.push(`http ${page.status}`);
  if (title) parts.push(title);
  return parts.join("; ").slice(0, SUMMARY_MAX);
}

export function routeFetchLogDecision(page: RoutePage): RouteFetchLogDecision | null {
  if (page.recalled) return null;
  if (page.error_class === "ssrf" || page.error_class === "non_https") {
    return { disposition: "rejected", failureCode: "ssrf_refused" };
  }
  if (page.error_class === "policy") {
    return { disposition: "rejected", failureCode: "instagram_not_scraped" };
  }
  if (isDeferredFetch(page) && page.error_class) {
    return { disposition: "deferred", failureCode: page.error_class };
  }
  const blocked = blockingSignal(page.signals);
  if (blocked) return { disposition: "rejected", failureCode: blocked };
  return null;
}

export function routeFetchOutcomeStillSkips(
  row: { disposition?: unknown; fetched_at?: unknown },
  now: Date,
): boolean {
  const at = Date.parse(String(row.fetched_at ?? ""));
  if (!Number.isFinite(at)) return false;
  const age = now.getTime() - at;
  if (age < 0) return false;
  const window = row.disposition === "deferred"
    ? ROUTE_DEFER_SKIP_MS
    : row.disposition === "rejected"
    ? ROUTE_REJECTION_SKIP_MS
    : 0;
  return window > 0 && age < window;
}

function playlistIdOf(raw: string | null | undefined): string | null {
  const id = (raw ?? "").trim();
  if (!id) return null;
  return id.slice(0, PLAYLIST_ID_MAX);
}

function pageFromRow(row: Record<string, unknown>): RoutePage | null {
  const disposition = String(row.disposition ?? "");
  const failureCode = String(row.failure_code ?? "");
  const fetchedAt = String(row.fetched_at ?? "");
  if (!fetchedAt) return null;
  const signals = emptySignals();
  let errorClass: RouteFetchErrorClass | null = null;
  if (disposition === "deferred") {
    if (!DEFERRED_CODES.has(failureCode)) return null;
    errorClass = failureCode as RouteFetchErrorClass;
  } else if (disposition === "rejected") {
    if (failureCode === "ssrf_refused") errorClass = "ssrf";
    else if (failureCode === "instagram_not_scraped") errorClass = "policy";
    else if (failureCode === "dead") signals.dead = true;
    else if (failureCode === "login_required") signals.login_required = true;
    else if (failureCode === "paywall_or_pay_to_play") signals.paywall_or_pay_to_play = true;
    else if (failureCode === "captcha") signals.captcha = true;
    else if (failureCode === "follow_gate") signals.follow_gate = true;
    else if (failureCode === "submissions_closed") signals.submissions_closed = true;
    else return null;
  } else {
    return null;
  }
  const statusRaw = row.http_status;
  const status = statusRaw == null || statusRaw === "" ? null : Number(statusRaw);
  return {
    ok: false,
    final_url: String(row.route_url ?? "") || null,
    status: status != null && Number.isFinite(status) ? status : null,
    content_type: null,
    title: null,
    text_excerpt: "",
    links: [],
    signals,
    fetched_at: fetchedAt,
    error: null,
    error_class: errorClass,
    recalled: true,
  };
}

async function recallRouteFetchOutcome(
  sb: RouteFetchLogClient,
  routeUrl: string,
  now: Date,
): Promise<RoutePage | null> {
  try {
    const selected = sb.from(ROUTE_FETCH_OUTCOMES_TABLE).select(
      "route_url, disposition, failure_code, http_status, fetched_at",
    );
    const filtered = typeof selected.eq === "function" ? selected.eq("route_url", routeUrl) : selected;
    const ordered = typeof filtered.order === "function"
      ? filtered.order("fetched_at", { ascending: false })
      : filtered;
    const limited = typeof ordered.limit === "function" ? ordered.limit(5) : ordered;
    const result = await limited;
    if (result?.error) return null;
    const data = result?.data;
    const rows = Array.isArray(data) ? data : data ? [data] : [];
    let latest: Record<string, unknown> | null = null;
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const rec = row as Record<string, unknown>;
      if (!latest || String(rec.fetched_at ?? "") > String(latest.fetched_at ?? "")) latest = rec;
    }
    if (!latest || !routeFetchOutcomeStillSkips(latest, now)) return null;
    return pageFromRow(latest);
  } catch {
    return null;
  }
}

/** Insert one outcome. Failures are ignored so verification still rejects or defers. */
export async function noteRouteFetchOutcome(
  sb: RouteFetchLogClient | null | undefined,
  opts: { playlistId?: string | null; routeUrl: string; page: RoutePage },
): Promise<boolean> {
  try {
    if (!sb) return false;
    const decision = routeFetchLogDecision(opts.page);
    const routeUrl = routeUrlKey(opts.routeUrl);
    if (!decision || !routeUrl) return false;
    const result = await sb.from(ROUTE_FETCH_OUTCOMES_TABLE).insert({
      playlist_id: playlistIdOf(opts.playlistId),
      route_url: routeUrl,
      disposition: decision.disposition,
      failure_code: decision.failureCode,
      http_status: opts.page.status,
      fetched_at: opts.page.fetched_at,
      evidence_summary: routeEvidenceSummary(opts.page, decision.failureCode),
    });
    return !result?.error;
  } catch {
    return false;
  }
}

/**
 * Fetch a route, or reuse a fresh rejected/deferred row for the same URL.
 * A reused row is not written again. A new rejection or deferral is appended.
 */
export async function fetchRoutePageRemembered(
  rawUrl: string,
  opts: {
    formUrl?: string | null;
    deps?: RouteFetchDeps;
    sb?: RouteFetchLogClient | null;
    playlistId?: string | null;
    timeoutMs?: number;
  } = {},
): Promise<RoutePage> {
  const now = opts.deps?.now?.() ?? new Date();
  const key = routeUrlKey(rawUrl);
  if (opts.sb && key) {
    const recalled = await recallRouteFetchOutcome(opts.sb, key, now);
    if (recalled) return recalled;
  }
  const page = await fetchRoutePage(rawUrl, {
    deps: opts.deps,
    formUrl: opts.formUrl,
    timeoutMs: opts.timeoutMs,
  });
  if (opts.sb && key) {
    await noteRouteFetchOutcome(opts.sb, {
      playlistId: opts.playlistId ?? null,
      routeUrl: rawUrl,
      page,
    });
  }
  return page;
}
