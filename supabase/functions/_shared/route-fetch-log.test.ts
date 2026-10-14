/**
 * Rejected and deferred route fetches are stored and reused.
 * No live network. A logged outcome is not a playlist target.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { evaluateSubmissionPath } from "./multichannel-path.ts";
import {
  DEFAULT_FORM_PAGE_HTML,
  emptySignals,
  routeFetchDepsReturning,
  type RouteFetchDeps,
  type RoutePage,
} from "./route-fetch.ts";
import {
  ROUTE_DEFER_SKIP_MS,
  ROUTE_FETCH_OUTCOMES_TABLE,
  ROUTE_REJECTION_SKIP_MS,
  routeEvidenceSummary,
  routeFetchOutcomeStillSkips,
  routeUrlKey,
} from "./route-fetch-log.ts";

type Row = Record<string, unknown>;

function memDb(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = { ...seed };
  const sb = {
    from(table: string) {
      if (!tables[table]) tables[table] = [];
      const filters: Record<string, unknown> = {};
      let mode: "select" | "insert" | "update" = "select";
      let payload: Row | null = null;
      const apply = () => tables[table].filter((r) =>
        Object.entries(filters).every(([k, v]) => String(r[k]) === String(v))
      );
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.insert = (row: Row) => {
        mode = "insert";
        payload = row;
        tables[table].push({ id: crypto.randomUUID(), ...row });
        return chain;
      };
      chain.update = (row: Row) => {
        mode = "update";
        payload = row;
        return chain;
      };
      chain.eq = (col: string, val: unknown) => {
        filters[col] = val;
        return chain;
      };
      chain.order = () => chain;
      chain.limit = () => chain;
      chain.maybeSingle = () => Promise.resolve({ data: apply()[0] ?? null, error: null });
      chain.then = (resolve: (v: unknown) => unknown) => {
        if (mode === "update" && payload) {
          for (const row of apply()) Object.assign(row, payload);
          return Promise.resolve(resolve({ data: null, error: null }));
        }
        if (mode === "insert") return Promise.resolve(resolve({ data: null, error: null }));
        return Promise.resolve(resolve({ data: apply(), error: null }));
      };
      return chain;
    },
  };
  return { sb, tables };
}

function countingDeps(html: string, status = 200, now = new Date("2026-10-14T12:00:00.000Z")) {
  let pageFetches = 0;
  const base = routeFetchDepsReturning(html, status);
  const inner = base.fetchImpl!;
  const deps: RouteFetchDeps = {
    ...base,
    now: () => now,
    fetchImpl: (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith("https://dns.google")) pageFetches++;
      return inner(input, init);
    },
  };
  return { deps, fetches: () => pageFetches };
}

const LOGIN_HTML =
  "<html><head><title>Sign in hidden.user@example.com</title></head><body>Please log in. BODYONLY_SECRET_9f3a</body></html>";

Deno.test("route URL key drops userinfo, tracking, email queries, and fragments", () => {
  assertEquals(
    routeUrlKey("https://User:secret@SubmitLink.io/wall/?utm_source=x&email=hidden.user@example.com&formID=99#top"),
    "https://submitlink.io/wall?formID=99",
  );
  assertEquals(routeUrlKey("http://curator.example/submit/"), "https://curator.example/submit");
  assertEquals(routeUrlKey("not a url"), null);
  assertEquals(routeUrlKey("ftp://curator.example/submit"), null);
});

Deno.test("evidence summary redacts emails and omits the page body", () => {
  const page: RoutePage = {
    ok: false,
    final_url: "https://curator.example/submit",
    status: 200,
    content_type: "text/html",
    title: "Login hidden.user@example.com",
    text_excerpt: "BODYONLY_SECRET_9f3a bob@other.test",
    links: [],
    signals: { ...emptySignals(), login_required: true },
    fetched_at: "2026-10-14T12:00:00.000Z",
    error: null,
    error_class: null,
  };
  const summary = routeEvidenceSummary(page, "login_required");
  assert(summary.includes("login_required"));
  assert(summary.includes("http 200"));
  assert(summary.includes("[redacted]"));
  assert(!summary.includes("hidden.user@example.com"));
  assert(!summary.includes("BODYONLY_SECRET_9f3a"));
  assert(!summary.includes("bob@other.test"));
  assert(summary.length <= 240);
});

Deno.test("skip windows expire at the boundary", () => {
  const now = new Date("2026-10-14T12:00:00.000Z");
  const at = (ms: number) => new Date(now.getTime() - ms).toISOString();
  assertEquals(routeFetchOutcomeStillSkips({ disposition: "rejected", fetched_at: at(ROUTE_REJECTION_SKIP_MS - 1) }, now), true);
  assertEquals(routeFetchOutcomeStillSkips({ disposition: "rejected", fetched_at: at(ROUTE_REJECTION_SKIP_MS) }, now), false);
  assertEquals(routeFetchOutcomeStillSkips({ disposition: "deferred", fetched_at: at(ROUTE_DEFER_SKIP_MS - 1) }, now), true);
  assertEquals(routeFetchOutcomeStillSkips({ disposition: "deferred", fetched_at: at(ROUTE_DEFER_SKIP_MS) }, now), false);
  assertEquals(routeFetchOutcomeStillSkips({ disposition: "other", fetched_at: at(0) }, now), false);
});

Deno.test("a login wall is logged, then reused without another fetch", async () => {
  const { sb, tables } = memDb();
  const now = new Date("2026-10-14T12:00:00.000Z");
  const { deps, fetches } = countingDeps(LOGIN_HTML, 200, now);
  const input = {
    submission_channel: "web_form",
    form_url: "https://submitlink.io/wall",
    form_source_evidence: "submitlink",
    playlist_id: "0DAtAjCytSoXd6T42mP0AA",
  };
  const first = await evaluateSubmissionPath(input, { sb: sb as never, routeFetch: deps });
  assertEquals(first.block_insert, true);
  assertEquals(first.code, "login_required");
  assert(fetches() >= 1);
  const seen = fetches();
  const logs = tables[ROUTE_FETCH_OUTCOMES_TABLE];
  assertEquals(logs.length, 1);
  assertEquals(logs[0].failure_code, "login_required");
  assertEquals(logs[0].disposition, "rejected");
  assertEquals(logs[0].playlist_id, "0DAtAjCytSoXd6T42mP0AA");
  assert(!JSON.stringify(logs[0]).includes("BODYONLY_SECRET_9f3a"));
  assert(!JSON.stringify(logs[0]).includes("hidden.user@example.com"));

  const second = await evaluateSubmissionPath(input, { sb: sb as never, routeFetch: deps });
  assertEquals(second.code, "login_required");
  assertEquals(second.block_insert, true);
  assertEquals(fetches(), seen);
  assertEquals(logs.length, 1);
});

Deno.test("a stale rejection is fetched again and appended", async () => {
  const now = new Date("2026-10-14T12:00:00.000Z");
  const { sb, tables } = memDb({
    [ROUTE_FETCH_OUTCOMES_TABLE]: [{
      playlist_id: "old",
      route_url: "https://submitlink.io/wall",
      disposition: "rejected",
      failure_code: "login_required",
      http_status: 200,
      fetched_at: new Date(now.getTime() - ROUTE_REJECTION_SKIP_MS - 1000).toISOString(),
      evidence_summary: "login_required; http 200",
    }],
  });
  const { deps, fetches } = countingDeps(LOGIN_HTML, 200, now);
  const path = await evaluateSubmissionPath({
    submission_channel: "web_form",
    form_url: "https://submitlink.io/wall",
    form_source_evidence: "submitlink",
    playlist_id: "0DAtAjCytSoXd6T42mP0AA",
  }, { sb: sb as never, routeFetch: deps });
  assertEquals(path.code, "login_required");
  assert(fetches() >= 1);
  assertEquals(tables[ROUTE_FETCH_OUTCOMES_TABLE].length, 2);
});

Deno.test("timeout, 5xx, and DNS deferrals are logged and a fresh deferral is not refetched", async () => {
  const now = new Date("2026-10-14T12:00:00.000Z");
  const { sb, tables } = memDb();
  const { deps } = countingDeps("nope", 503, now);
  const down = await evaluateSubmissionPath({
    submission_channel: "web_form",
    form_url: "https://curator.example/down",
    form_source_evidence: "curator",
    playlist_id: "pl-down",
  }, { sb: sb as never, routeFetch: deps });
  assertEquals(down.retryable, true);
  assertEquals(down.code, "temporary_host_failure");
  assertEquals(down.block_insert, undefined);
  assertEquals(tables[ROUTE_FETCH_OUTCOMES_TABLE][0].failure_code, "http_5xx");
  assertEquals(tables[ROUTE_FETCH_OUTCOMES_TABLE][0].http_status, 503);
  assertEquals(tables[ROUTE_FETCH_OUTCOMES_TABLE][0].disposition, "deferred");

  const nx: RouteFetchDeps = {
    now: () => now,
    resolveHost: () => Promise.resolve([]),
    fetchImpl: () => Promise.resolve(new Response(DEFAULT_FORM_PAGE_HTML, { status: 200 })),
  };
  const dns = await evaluateSubmissionPath({
    submission_channel: "web_form",
    form_url: "https://missing.example/submit",
    form_source_evidence: "missing",
    playlist_id: "pl-dns",
  }, { sb: sb as never, routeFetch: nx });
  assertEquals(dns.retryable, true);
  const dnsRow = tables[ROUTE_FETCH_OUTCOMES_TABLE].find((r) => r.route_url === "https://missing.example/submit");
  assertEquals(dnsRow?.failure_code, "dns");
  assertEquals(dnsRow?.http_status, null);
  assertEquals(dnsRow?.playlist_id, "pl-dns");

  let timedOut = 0;
  const slow: RouteFetchDeps = {
    now: () => now,
    timeoutMs: 30,
    resolveHost: () => Promise.resolve(["93.184.216.34"]),
    fetchImpl: (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("https://dns.google")) {
        return Promise.resolve(new Response(JSON.stringify({
          Status: 0,
          Answer: [{ type: 1, data: "93.184.216.34" }],
        }), { status: 200, headers: { "content-type": "application/json" } }));
      }
      timedOut++;
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new DOMException("aborted", "AbortError"));
        if (init?.signal?.aborted) abort();
        else init?.signal?.addEventListener("abort", abort);
      });
    },
  };
  const input = {
    submission_channel: "web_form",
    form_url: "https://slow.example/submit",
    form_source_evidence: "slow",
    playlist_id: "pl-slow",
  };
  const timeout = await evaluateSubmissionPath(input, { sb: sb as never, routeFetch: slow });
  assertEquals(timeout.retryable, true);
  const timeoutRow = tables[ROUTE_FETCH_OUTCOMES_TABLE].find((r) => r.failure_code === "timeout");
  assertEquals(timeoutRow?.disposition, "deferred");
  assertEquals(timeoutRow?.playlist_id, "pl-slow");
  assertEquals(timeoutRow?.http_status, null);
  const again = await evaluateSubmissionPath(input, { sb: sb as never, routeFetch: slow });
  assertEquals(again.retryable, true);
  assertEquals(timedOut, 1);
  const retryAt = Date.parse(String(again.retry_after));
  assertEquals(retryAt, now.getTime() + ROUTE_DEFER_SKIP_MS);
});

Deno.test("SSRF refusals are logged and not inserted as a pass", async () => {
  const { sb, tables } = memDb();
  let fetched = 0;
  const deps: RouteFetchDeps = {
    fetchImpl: () => {
      fetched++;
      return Promise.resolve(new Response("nope", { status: 200 }));
    },
  };
  const path = await evaluateSubmissionPath({
    submission_channel: "web_form",
    form_url: "https://127.0.0.1/submit",
    form_source_evidence: "local",
    playlist_id: "pl-ssrf",
  }, { sb: sb as never, routeFetch: deps });
  assertEquals(path.block_insert, true);
  assertEquals(path.code, "ssrf_refused");
  assertEquals(fetched, 0);
  assertEquals(tables[ROUTE_FETCH_OUTCOMES_TABLE][0].failure_code, "ssrf_refused");
  assertEquals(tables[ROUTE_FETCH_OUTCOMES_TABLE][0].http_status, null);
  assertEquals(tables[ROUTE_FETCH_OUTCOMES_TABLE].length, 1);
});

Deno.test("a passing form is not written to the rejection log", async () => {
  const { sb, tables } = memDb();
  const { deps } = countingDeps(DEFAULT_FORM_PAGE_HTML);
  const path = await evaluateSubmissionPath({
    submission_channel: "web_form",
    form_url: "https://curator.example/submit",
    form_source_evidence: "curator form",
    playlist_id: "pl-ok",
  }, { sb: sb as never, routeFetch: deps });
  assertEquals(path.path_verified, true);
  assertEquals(tables[ROUTE_FETCH_OUTCOMES_TABLE]?.length ?? 0, 0);
});

Deno.test("a dead form is logged with its HTTP status", async () => {
  const { sb, tables } = memDb();
  const { deps } = countingDeps("<html>missing</html>", 404);
  const path = await evaluateSubmissionPath({
    submission_channel: "web_form",
    form_url: "https://curator.example/gone",
    form_source_evidence: "curator",
    playlist_id: "pl-dead",
  }, { sb: sb as never, routeFetch: deps });
  assertEquals(path.code, "dead");
  assertEquals(path.block_insert, true);
  assertEquals(tables[ROUTE_FETCH_OUTCOMES_TABLE][0].http_status, 404);
  assertEquals(tables[ROUTE_FETCH_OUTCOMES_TABLE][0].failure_code, "dead");
});

Deno.test("a rendered login wall is logged and the next check does not render again", async () => {
  const shell = "<html><div id=\"root\"></div><script src=\"/app.js\"></script></html>";
  const setting = { enabled: true, daily_cap: 25, used_date: null as string | null, used_count: 0 };
  const { sb, tables } = memDb({
    ops_settings: [{ setting_key: "route_fetch_firecrawl_fallback", setting_value: setting }],
  });
  let renders = 0;
  const { deps, fetches } = countingDeps(shell);
  deps.firecrawlRender = () => {
    renders++;
    return Promise.resolve({ html: LOGIN_HTML, markdown: "Please log in hidden.user@example.com" });
  };
  const input = {
    submission_channel: "web_form",
    form_url: "https://submitlink.io/app",
    form_source_evidence: "submitlink",
    playlist_id: "pl-js",
  };
  const first = await evaluateSubmissionPath(input, { sb: sb as never, routeFetch: deps });
  assertEquals(first.code, "login_required");
  assertEquals(first.block_insert, true);
  assertEquals(renders, 1);
  assertEquals(tables[ROUTE_FETCH_OUTCOMES_TABLE].length, 1);
  assertEquals(tables[ROUTE_FETCH_OUTCOMES_TABLE][0].failure_code, "login_required");
  assert(!JSON.stringify(tables[ROUTE_FETCH_OUTCOMES_TABLE][0]).includes("hidden.user@example.com"));
  const seen = fetches();
  const second = await evaluateSubmissionPath(input, { sb: sb as never, routeFetch: deps });
  assertEquals(second.code, "login_required");
  assertEquals(renders, 1);
  assertEquals(fetches(), seen);
  assertEquals(tables[ROUTE_FETCH_OUTCOMES_TABLE].length, 1);
});

Deno.test("a log write failure still rejects the route", async () => {
  const sb = {
    from() {
      return {
        select: () => ({
          eq: () => ({
            order: () => ({
              limit: () => Promise.resolve({ data: [], error: { message: "relation missing" } }),
            }),
          }),
        }),
        insert: () => Promise.resolve({ error: { message: "insert refused" } }),
      };
    },
  };
  const { deps } = countingDeps(LOGIN_HTML);
  const path = await evaluateSubmissionPath({
    submission_channel: "web_form",
    form_url: "https://submitlink.io/wall",
    form_source_evidence: "submitlink",
    playlist_id: "pl-fail",
  }, { sb: sb as never, routeFetch: deps });
  assertEquals(path.code, "login_required");
  assertEquals(path.block_insert, true);
});
