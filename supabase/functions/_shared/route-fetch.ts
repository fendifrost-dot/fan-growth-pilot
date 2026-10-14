/**
 * Server-side fetch of a curator submission page.
 *
 * AGH loads the page itself. Agent evidence text is a hint, not the proof.
 * The fetch is SSRF-safe: https only, no cookies, no IP literals, and every
 * redirect hop is re-checked against loopback, private, link-local and
 * cloud-metadata ranges (IPv4 and IPv6).
 *
 * DNS uses DNS-over-HTTPS. Supabase Edge does not reliably expose Deno.resolveDns
 * (same constraint as verify-target.ts).
 */
import { firecrawlScrape } from "./firecrawl.ts";
import {
  evidenceLooksLikeCaptcha,
  evidenceLooksLikeDeadPage,
  evidenceLooksLikeFollowGate,
  evidenceLooksLikeLoginWall,
  evidenceLooksLikePaywall,
  evidenceNegatesRoute,
  hostLabel,
  hostOf,
  isFormBuilderHost,
  isNonFormHost,
} from "./submission-route.ts";

export const ROUTE_FETCH_TIMEOUT_MS = 8_000;
export const ROUTE_FETCH_MAX_REDIRECTS = 3;
export const ROUTE_FETCH_MAX_BYTES = 512 * 1024;
export const ROUTE_FETCH_USER_AGENT = "FanFuelHub-RouteFetch/1.0 (AGH submission route verification)";
const DOH_URL = "https://dns.google/resolve";
const EXCERPT_CHARS = 1_500;

export type RouteFetchErrorClass =
  | "ssrf"
  | "timeout"
  | "dns"
  | "http_5xx"
  | "network"
  | "too_many_redirects"
  | "policy"
  | "non_https";

export type RoutePageSignals = {
  dead: boolean;
  login_required: boolean;
  paywall_or_pay_to_play: boolean;
  captcha: boolean;
  follow_gate: boolean;
  submissions_closed: boolean;
  has_form: boolean;
  links_to_form: boolean;
  /** Plain fetch returned a JS shell with no form and no rejection signal. */
  js_only: boolean;
};

export type RoutePage = {
  ok: boolean;
  final_url: string | null;
  status: number | null;
  content_type: string | null;
  title: string | null;
  text_excerpt: string;
  links: string[];
  signals: RoutePageSignals;
  fetched_at: string;
  error: string | null;
  error_class: RouteFetchErrorClass | null;
  /** Rebuilt from agh_route_fetch_outcomes. Not a new network fetch. */
  recalled?: boolean;
};

export type RouteFetchDeps = {
  fetchImpl?: typeof fetch;
  resolveHost?: (hostname: string) => Promise<string[]>;
  now?: () => Date;
  /** Test double for the Firecrawl renderer. Production uses firecrawlScrape. */
  firecrawlRender?: (url: string) => Promise<{ html: string; markdown: string }>;
  /** Overrides the 8s timeout. Production leaves this unset. */
  timeoutMs?: number;
};

type FetchOpts = {
  timeoutMs?: number;
  maxRedirects?: number;
  maxBytes?: number;
  /** When set, links_to_form is computed against this form URL. */
  formUrl?: string | null;
  deps?: RouteFetchDeps;
};

const BLOCKED_HOSTS = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata.google.com",
  "metadata.goog",
]);

const OAUTH_HOSTS = [
  "accounts.google.com",
  "appleid.apple.com",
  "login.microsoftonline.com",
  "login.live.com",
];

export function emptySignals(): RoutePageSignals {
  return {
    dead: false,
    login_required: false,
    paywall_or_pay_to_play: false,
    captcha: false,
    follow_gate: false,
    submissions_closed: false,
    has_form: false,
    links_to_form: false,
    js_only: false,
  };
}

function emptyPage(error: string, errorClass: RouteFetchErrorClass, now: Date): RoutePage {
  return {
    ok: false,
    final_url: null,
    status: null,
    content_type: null,
    title: null,
    text_excerpt: "",
    links: [],
    signals: emptySignals(),
    fetched_at: now.toISOString(),
    error,
    error_class: errorClass,
  };
}

export function isInstagramHost(urlOrHost: string): boolean {
  const h = urlOrHost.includes("://") ? hostOf(urlOrHost) : urlOrHost.toLowerCase().replace(/^www\./, "");
  return !!h && (h === "instagram.com" || h.endsWith(".instagram.com"));
}

/** Hostname is an IP literal (v4, v6, decimal, hex, octal, or short dotted form). */
export function isIpLiteralHost(hostname: string): boolean {
  let h = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (!h) return false;
  if (h.includes(":")) return true;
  if (/^\d+$/.test(h)) return true;
  if (/^0x[0-9a-f]+$/.test(h)) return true;
  if (/^(?:\d+|0x[0-9a-f]+)(?:\.(?:\d+|0x[0-9a-f]+)){1,3}$/.test(h)) return true;
  return false;
}

function parseIPv4(s: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s.trim());
  if (!m) return null;
  const parts = m.slice(1).map((p) => Number(p));
  if (parts.some((n) => !Number.isInteger(n) || n > 255)) return null;
  return parts;
}

export function isBlockedIPv4(parts: number[]): boolean {
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true; // multicast and reserved
  return false;
}

function expandIPv6(ip: string): number[] | null {
  let s = ip.trim().toLowerCase();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  const v4tail = s.match(/^(.*):(\d+\.\d+\.\d+\.\d+)$/);
  if (v4tail) {
    const p = parseIPv4(v4tail[2]);
    if (!p) return null;
    const hi = ((p[0] << 8) | p[1]).toString(16);
    const lo = ((p[2] << 8) | p[3]).toString(16);
    s = `${v4tail[1]}:${hi}:${lo}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const side = (part: string): number[] | null => {
    if (!part) return [];
    const groups = part.split(":");
    const nums = groups.map((g) => /^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN);
    if (nums.some((n) => Number.isNaN(n))) return null;
    return nums;
  };
  if (halves.length === 2) {
    const left = side(halves[0]);
    const right = side(halves[1]);
    if (!left || !right) return null;
    const missing = 8 - left.length - right.length;
    if (missing < 0) return null;
    return [...left, ...Array(missing).fill(0), ...right];
  }
  const full = side(s);
  if (!full || full.length !== 8) return null;
  return full;
}

function ipv4FromGroups(hi: number, lo: number): number[] {
  return [(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255];
}

/** True when a resolved address is loopback, private, link-local, metadata, or otherwise non-global. */
export function isBlockedIp(ip: string): boolean {
  const trimmed = ip.trim().toLowerCase();
  const v4 = parseIPv4(trimmed);
  if (v4) return isBlockedIPv4(v4);
  const g = expandIPv6(trimmed);
  if (!g) return true;
  if (g.every((n) => n === 0)) return true; // ::
  if (g.slice(0, 7).every((n) => n === 0) && g[7] === 1) return true; // ::1
  // IPv4-mapped ::ffff:0:0/96
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
    return isBlockedIPv4(ipv4FromGroups(g[6], g[7]));
  }
  // NAT64 64:ff9b::/96 — judge the embedded IPv4
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
    return isBlockedIPv4(ipv4FromGroups(g[6], g[7]));
  }
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true; // 100::/64 discard
  return false;
}

function blockedHostnameReason(hostname: string): string | null {
  const h = hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (!h) return "empty_host";
  if (isIpLiteralHost(h)) return "ip_literal";
  if (BLOCKED_HOSTS.has(h)) return "blocked_host";
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) {
    return "local_name";
  }
  if (isInstagramHost(h)) return "instagram";
  return null;
}

function upgradeToHttps(raw: string): { url: URL | null; error: RouteFetchErrorClass | null; detail: string | null } {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return { url: null, error: "non_https", detail: "invalid_url" };
  }
  if (parsed.username || parsed.password) {
    return { url: null, error: "ssrf", detail: "url_credentials" };
  }
  if (parsed.protocol === "http:") {
    parsed = new URL(parsed.href.replace(/^http:/i, "https:"));
  }
  if (parsed.protocol !== "https:") {
    return { url: null, error: "non_https", detail: `protocol_${parsed.protocol}` };
  }
  return { url: parsed, error: null, detail: null };
}

async function defaultResolve(hostname: string, fetchImpl: typeof fetch, signal: AbortSignal): Promise<string[]> {
  const ips: string[] = [];
  let sawNx = 0;
  for (const type of ["A", "AAAA"] as const) {
    const res = await fetchImpl(
      `${DOH_URL}?name=${encodeURIComponent(hostname)}&type=${type}`,
      {
        headers: { accept: "application/dns-json", "user-agent": ROUTE_FETCH_USER_AGENT },
        redirect: "manual",
        credentials: "omit",
        cache: "no-store",
        signal,
      },
    );
    if (!res.ok) throw Object.assign(new Error(`resolver_http_${res.status}`), { errorClass: "dns" as const });
    const data = await res.json() as { Status?: number; Answer?: { type?: number; data?: string }[] };
    if (data.Status === 3) {
      sawNx++;
      continue;
    }
    if (data.Status !== 0) throw Object.assign(new Error(`resolver_status_${data.Status}`), { errorClass: "dns" as const });
    const want = type === "A" ? 1 : 28;
    for (const ans of data.Answer ?? []) {
      if (ans.type === want && ans.data) ips.push(String(ans.data).replace(/\.$/, ""));
    }
  }
  if (!ips.length) {
    throw Object.assign(new Error(sawNx === 2 ? "nxdomain" : "no_addresses"), { errorClass: "dns" as const });
  }
  return ips;
}

function sameHostLabel(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const ha = hostOf(a);
  const hb = hostOf(b);
  if (!ha || !hb) return false;
  if (ha === hb) return true;
  const la = hostLabel(ha);
  const lb = hostLabel(hb);
  return la.length >= 3 && la === lb;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function pageTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return null;
  const t = stripHtml(m[1]).slice(0, 200);
  return t || null;
}

function pageLinks(html: string, base: string): string[] {
  const out: string[] = [];
  const re = /\b(?:href|src)\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < 100) {
    const raw = m[1].trim();
    if (!raw || raw.startsWith("#") || raw.startsWith("javascript:") || raw.startsWith("mailto:")) continue;
    try {
      out.push(new URL(raw, base).href);
    } catch {
      // ignore unresolvable hrefs
    }
  }
  return out;
}

function htmlHasForm(html: string, pageUrl: string | null): boolean {
  if (/<form[\s>]/i.test(html)) return true;
  if (pageUrl && isFormBuilderHost(pageUrl)) return true;
  return /<(iframe|script|embed)[^>]+(typeform|jotform|forms\.gle|docs\.google\.com\/forms|tally\.so|airtable\.com|formstack|wufoo)/i
    .test(html);
}

function looksLikeJsShell(html: string, text: string): boolean {
  if (text.length >= 400) return false;
  return /id=["'](?:__next|root|app)["']|enable javascript|<script\b/i.test(html);
}

/**
 * Pure classifier. `html` is used for form/captcha markers and is not returned.
 */
export function classifyRoutePage(
  page: {
    status: number | null;
    final_url: string | null;
    title: string | null;
    text_excerpt: string;
    html?: string;
    links: string[];
  },
  opts?: { formUrl?: string | null },
): RoutePageSignals {
  const signals = emptySignals();
  const html = page.html ?? "";
  const blob = `${page.title ?? ""} ${page.text_excerpt} ${html}`;
  const status = page.status ?? 0;
  if (status === 404 || status === 410 || evidenceLooksLikeDeadPage(blob)) signals.dead = true;
  const path = (() => {
    try {
      return page.final_url ? new URL(page.final_url).pathname.toLowerCase() : "";
    } catch {
      return "";
    }
  })();
  const host = page.final_url ? hostOf(page.final_url) : null;
  const oauthRedirect = !!host && OAUTH_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  const loginPath = /\/(login|signin|sign-in|sign_in|oauth|auth)(\/|$)/.test(path);
  const loginText = evidenceLooksLikeLoginWall(blob);
  signals.has_form = htmlHasForm(html, page.final_url) || (!!page.final_url && isFormBuilderHost(page.final_url));
  // A login wall, not a public form that also has a "log in" link in the nav.
  if (status === 401 || status === 403 || oauthRedirect || loginPath || (loginText && !signals.has_form)) {
    signals.login_required = true;
  }
  if (evidenceLooksLikePaywall(blob)) signals.paywall_or_pay_to_play = true;
  if (evidenceLooksLikeCaptcha(blob)) signals.captcha = true;
  if (evidenceLooksLikeFollowGate(blob)) signals.follow_gate = true;
  if (evidenceNegatesRoute(blob)) signals.submissions_closed = true;
  const formUrl = opts?.formUrl ?? null;
  if (formUrl) {
    // A link on this page to the form's host. The page being the form itself is has_form, not this.
    signals.links_to_form = page.links.some((href) => sameHostLabel(href, formUrl));
  }
  const blocking = signals.dead || signals.login_required || signals.paywall_or_pay_to_play ||
    signals.captcha || signals.follow_gate || signals.submissions_closed || signals.has_form;
  if (!blocking && looksLikeJsShell(html, page.text_excerpt)) signals.js_only = true;
  return signals;
}

export function blockingSignal(signals: RoutePageSignals): string | null {
  if (signals.dead) return "dead";
  if (signals.captcha) return "captcha";
  if (signals.login_required) return "login_required";
  if (signals.paywall_or_pay_to_play) return "paywall_or_pay_to_play";
  if (signals.follow_gate) return "follow_gate";
  if (signals.submissions_closed) return "submissions_closed";
  return null;
}

async function readCapped(res: Response, maxBytes: number): Promise<{ html: string; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) {
    const text = await res.text().catch(() => "");
    return { html: text.slice(0, maxBytes), truncated: text.length > maxBytes };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value?.byteLength) continue;
    if (total + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - total));
      total = maxBytes;
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buf.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { html: new TextDecoder().decode(buf), truncated };
}

async function assertResolvable(hostname: string, deps: RouteFetchDeps, fetchImpl: typeof fetch, signal: AbortSignal): Promise<void> {
  const reason = blockedHostnameReason(hostname);
  if (reason) {
    const cls: RouteFetchErrorClass = reason === "instagram" ? "policy" : "ssrf";
    throw Object.assign(new Error(reason), { errorClass: cls });
  }
  const ips = deps.resolveHost
    ? await deps.resolveHost(hostname)
    : await defaultResolve(hostname, fetchImpl, signal);
  if (!ips.length) throw Object.assign(new Error("no_addresses"), { errorClass: "dns" as const });
  for (const ip of ips) {
    if (isBlockedIp(ip)) throw Object.assign(new Error(`blocked_ip:${ip}`), { errorClass: "ssrf" as const });
  }
}

function errorClassOf(e: unknown): RouteFetchErrorClass {
  if (e && typeof e === "object" && "errorClass" in e) {
    return (e as { errorClass: RouteFetchErrorClass }).errorClass;
  }
  const name = e && typeof e === "object" && "name" in e ? String((e as { name: unknown }).name) : "";
  if (name === "AbortError" || name === "TimeoutError") return "timeout";
  const msg = e instanceof Error ? e.message : String(e);
  if (/abort|timed out|timeout/i.test(msg)) return "timeout";
  return "network";
}

/**
 * Fetch one curator page. Redirects are manual so each hop is SSRF-checked.
 * http:// is upgraded to https:// before any request. Cookies and credentials
 * are never sent.
 */
export async function fetchRoutePage(rawUrl: string, opts: FetchOpts = {}): Promise<RoutePage> {
  const now = opts.deps?.now?.() ?? new Date();
  const timeoutMs = opts.timeoutMs ?? opts.deps?.timeoutMs ?? ROUTE_FETCH_TIMEOUT_MS;
  const maxRedirects = opts.maxRedirects ?? ROUTE_FETCH_MAX_REDIRECTS;
  const maxBytes = opts.maxBytes ?? ROUTE_FETCH_MAX_BYTES;
  const deps = opts.deps ?? {};
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  const fail = (error: string, errorClass: RouteFetchErrorClass, status: number | null = null): RoutePage => {
    clearTimeout(timer);
    return { ...emptyPage(error, errorClass, now), status };
  };

  try {
    let current = upgradeToHttps(rawUrl);
    if (!current.url || current.error) {
      return fail(current.detail ?? "refused", current.error ?? "non_https");
    }
    let redirects = 0;
    let res: Response | null = null;
    while (redirects <= maxRedirects) {
      const url = current.url;
      if (!url) return fail("invalid_url", "non_https");
      try {
        await assertResolvable(url.hostname, deps, fetchImpl, ctrl.signal);
      } catch (e) {
        const cls = errorClassOf(e);
        return fail(e instanceof Error ? e.message : String(e), cls === "network" ? "dns" : cls);
      }
      res = await fetchImpl(url.href, {
        method: "GET",
        redirect: "manual",
        credentials: "omit",
        cache: "no-store",
        signal: ctrl.signal,
        headers: {
          "user-agent": ROUTE_FETCH_USER_AGENT,
          accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        },
      });
      const loc = res.headers.get("location");
      const isRedirect = res.status >= 300 && res.status < 400 && !!loc;
      if (!isRedirect) break;
      redirects++;
      let next: URL;
      try {
        next = new URL(loc!, url);
      } catch {
        return fail("bad_redirect", "network");
      }
      const upgraded = upgradeToHttps(next.href);
      if (!upgraded.url || upgraded.error) return fail(upgraded.detail ?? "bad_redirect", upgraded.error ?? "non_https");
      // Check the next hop even when we will not follow it.
      try {
        await assertResolvable(upgraded.url.hostname, deps, fetchImpl, ctrl.signal);
      } catch (e) {
        const cls = errorClassOf(e);
        return fail(e instanceof Error ? e.message : String(e), cls === "network" ? "dns" : cls);
      }
      if (redirects > maxRedirects) return fail("too_many_redirects", "too_many_redirects");
      current = upgraded;
      await res.body?.cancel().catch(() => {});
    }
    if (!res || !current.url) return fail("no_response", "network");
    const status = res.status;
    if (status >= 500 || status === 429) return fail(`http_${status}`, "http_5xx", status);
    const contentType = res.headers.get("content-type");
    const { html } = await readCapped(res, maxBytes);
    const text = stripHtml(html);
    const links = pageLinks(html, current.url.href);
    const signals = classifyRoutePage({
      status,
      final_url: current.url.href,
      title: pageTitle(html),
      text_excerpt: text.slice(0, 8_000),
      html,
      links,
    }, { formUrl: opts.formUrl ?? null });
    clearTimeout(timer);
    return {
      ok: status >= 200 && status < 500,
      final_url: current.url.href,
      status,
      content_type: contentType,
      title: pageTitle(html),
      text_excerpt: text.slice(0, EXCERPT_CHARS),
      links,
      signals,
      fetched_at: now.toISOString(),
      error: null,
      error_class: null,
    };
  } catch (e) {
    const cls = errorClassOf(e);
    return fail(e instanceof Error ? e.message : String(e), cls);
  } finally {
    clearTimeout(timer);
  }
}

export type FirecrawlFallbackSetting = {
  enabled: boolean;
  daily_cap: number;
  used_date: string | null;
  used_count: number;
};

export function parseFirecrawlFallbackSetting(value: unknown): FirecrawlFallbackSetting {
  const v = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const cap = Number(v.daily_cap);
  return {
    enabled: v.enabled === true,
    daily_cap: Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : 25,
    used_date: typeof v.used_date === "string" ? v.used_date : null,
    used_count: Number(v.used_count) > 0 ? Math.floor(Number(v.used_count)) : 0,
  };
}

type SbLike = {
  from: (table: string) => {
    select: (cols: string) => {
      eq: (col: string, val: string) => {
        maybeSingle: () => Promise<{ data: Record<string, unknown> | null; error: { message: string } | null }>;
      };
    };
    update: (row: Record<string, unknown>) => {
      eq: (col: string, val: string) => Promise<{ error: { message: string } | null }>;
    };
  };
};

/**
 * When the ops setting is on and the daily cap has room, render the page.
 * Returns null when the fallback is off, capped, or the render fails.
 * A failed or skipped render is never a pass.
 */
export async function renderJsPage(
  sb: SbLike | null | undefined,
  url: string,
  deps?: RouteFetchDeps,
): Promise<{ html: string; markdown: string } | null> {
  if (!sb) return null;
  const { data, error } = await sb.from("ops_settings").select("setting_value").eq("setting_key", "route_fetch_firecrawl_fallback").maybeSingle();
  if (error || !data) return null;
  const setting = parseFirecrawlFallbackSetting(data.setting_value);
  if (!setting.enabled) return null;
  const today = (deps?.now?.() ?? new Date()).toISOString().slice(0, 10);
  const used = setting.used_date === today ? setting.used_count : 0;
  if (used >= setting.daily_cap) return null;
  const next = { ...setting, enabled: true, daily_cap: setting.daily_cap, used_date: today, used_count: used + 1 };
  await sb.from("ops_settings").update({
    setting_value: next,
    updated_at: (deps?.now?.() ?? new Date()).toISOString(),
  }).eq("setting_key", "route_fetch_firecrawl_fallback");
  try {
    if (deps?.firecrawlRender) return await deps.firecrawlRender(url);
    const scraped = await firecrawlScrape(url, { formats: ["html", "markdown"], timeoutMs: ROUTE_FETCH_TIMEOUT_MS });
    return { html: scraped.html || scraped.markdown, markdown: scraped.markdown };
  } catch {
    return null;
  }
}

/** A page the server actually loaded, stored on playlist_targets.research_context. No HTML body. */
export function routeFetchRecord(page: RoutePage): Record<string, unknown> {
  return {
    method: "server_fetch",
    fetched_at: page.fetched_at,
    final_url: page.final_url,
    status: page.status,
    signals: page.signals,
    title: page.title,
    text_excerpt: page.text_excerpt.slice(0, 500),
  };
}

export function isDeferredFetch(page: RoutePage): boolean {
  return page.error_class === "timeout" || page.error_class === "dns" || page.error_class === "http_5xx" ||
    page.error_class === "network" || page.error_class === "too_many_redirects";
}

/** First-party curator site. Instagram and listening-platform pages are not scraped as proof. */
export function isFirstPartySource(url: string | null | undefined): boolean {
  const raw = (url ?? "").trim();
  if (!/^https?:\/\//i.test(raw)) return false;
  if (isInstagramHost(raw) || isNonFormHost(raw)) return false;
  return true;
}

export const DEFAULT_FORM_PAGE_HTML =
  `<!doctype html><html><head><title>Submit music</title></head><body><h1>Submit your track</h1><form action="/submit" method="post"><input name="link"><button type="submit">Submit</button></form></body></html>`;

/** Public-address resolver + HTML response, for unit tests. Not used in production. */
export function routeFetchDepsReturning(html: string, status = 200): RouteFetchDeps {
  return {
    resolveHost: () => Promise.resolve(["93.184.216.34"]),
    fetchImpl: (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith(DOH_URL)) {
        return Promise.resolve(new Response(JSON.stringify({
          Status: 0,
          Answer: [{ type: 1, data: "93.184.216.34" }],
        }), { status: 200, headers: { "content-type": "application/json" } }));
      }
      return Promise.resolve(new Response(html, {
        status,
        headers: { "content-type": "text/html; charset=utf-8" },
      }));
    },
  };
}
