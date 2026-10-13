/**
 * Server-side route fetch: SSRF guards, redirect re-check, size and time
 * limits, page-signal classification, deferred transport failures, and the
 * prior-structural-rejection rule. No live network.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { evaluateSubmissionPath } from "./multichannel-path.ts";
import {
  reverifyManuallyVerifiedTarget,
  playlistDiscoveryActor,
} from "./playlist-discovery-mcp.ts";
import {
  isStructuralRouteRejection,
  priorStructuralRouteBlock,
} from "./submission-route.ts";
import {
  blockingSignal,
  classifyRoutePage,
  DEFAULT_FORM_PAGE_HTML,
  emptySignals,
  fetchRoutePage,
  isBlockedIp,
  isBlockedIPv4,
  isDeferredFetch,
  isIpLiteralHost,
  parseFirecrawlFallbackSetting,
  renderJsPage,
  ROUTE_FETCH_MAX_BYTES,
  ROUTE_FETCH_TIMEOUT_MS,
  ROUTE_FETCH_USER_AGENT,
  routeFetchDepsReturning,
  type RouteFetchDeps,
  type RoutePageSignals,
} from "./route-fetch.ts";

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function htmlResponse(html: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
  });
}

function depsFor(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  resolveHost?: (hostname: string) => Promise<string[]>,
): { deps: RouteFetchDeps; fetched: string[] } {
  const fetched: string[] = [];
  return {
    fetched,
    deps: {
      resolveHost: resolveHost ?? (() => Promise.resolve(["93.184.216.34"])),
      fetchImpl: (input, init) => {
        fetched.push(urlOf(input));
        return Promise.resolve(handler(urlOf(input), init));
      },
    },
  };
}

const PUBLIC = ["93.184.216.34"];

Deno.test("timeout constant is about 8 seconds", () => {
  assertEquals(ROUTE_FETCH_TIMEOUT_MS, 8_000);
  assertEquals(ROUTE_FETCH_MAX_BYTES, 512 * 1024);
  assert(ROUTE_FETCH_USER_AGENT.includes("FanFuelHub-RouteFetch"));
});

Deno.test("IP literals and non-global addresses are refused before any fetch", async () => {
  const refused = [
    "https://127.0.0.1/",
    "http://169.254.169.254/",
    "https://10.1.2.3/latest/meta-data",
    "https://192.168.1.9/",
    "https://172.16.0.4/",
    "https://100.64.0.1/",
    "https://0.0.0.0/",
    "https://2130706433/",
    "https://0x7f000001/",
    "https://0177.0.0.1/",
    "https://8.8.8.8/",
    "https://[::1]/",
    "https://[fc00::1]/",
    "https://[fe80::1]/",
    "https://[::ffff:127.0.0.1]/",
    "https://[::ffff:169.254.169.254]/",
    "https://[64:ff9b::127.0.0.1]/",
    "https://localhost/",
    "https://foo.local/",
    "https://bar.localhost/",
    "https://baz.internal/",
    "https://metadata.google.internal/",
    "https://metadata.google.com/",
    "https://metadata.goog/",
    "https://user:pass@curator.example/submit",
  ];
  for (const raw of refused) {
    let resolved = false;
    const { deps, fetched } = depsFor(() => htmlResponse(DEFAULT_FORM_PAGE_HTML), () => {
      resolved = true;
      return Promise.resolve(PUBLIC);
    });
    const page = await fetchRoutePage(raw, { deps });
    assertEquals(page.ok, false, raw);
    assertEquals(page.error_class, "ssrf", `${raw} -> ${page.error_class} ${page.error}`);
    assertEquals(fetched.length, 0, raw);
    assertEquals(resolved, false, raw);
  }
});

Deno.test("a name that resolves to a public address is fetched; a private answer is not", async () => {
  const good = depsFor(() => htmlResponse(DEFAULT_FORM_PAGE_HTML), () => Promise.resolve(["8.8.8.8"]));
  const ok = await fetchRoutePage("https://curator.example/submit", { deps: good.deps });
  assertEquals(ok.ok, true);
  assertEquals(ok.signals.has_form, true);
  assertEquals(good.fetched.length, 1);
  assert(good.fetched[0].startsWith("https://curator.example/"));

  const bad = depsFor(() => htmlResponse(DEFAULT_FORM_PAGE_HTML), () => Promise.resolve(["2001:4860:4860::8888", "10.0.0.1"]));
  const blocked = await fetchRoutePage("https://curator.example/submit", { deps: bad.deps });
  assertEquals(blocked.error_class, "ssrf");
  assertEquals(bad.fetched.length, 0);

  const v6 = depsFor(() => htmlResponse(DEFAULT_FORM_PAGE_HTML), () => Promise.resolve(["2001:4860:4860::8888"]));
  const v6ok = await fetchRoutePage("https://curator.example/submit", { deps: v6.deps });
  assertEquals(v6ok.ok, true);
});

Deno.test("blocked-range helpers distinguish private space from the addresses next to it", () => {
  assert(isBlockedIPv4([172, 16, 0, 1]));
  assert(isBlockedIPv4([172, 31, 255, 255]));
  assert(!isBlockedIPv4([172, 15, 0, 1]));
  assert(!isBlockedIPv4([11, 0, 0, 1]));
  assert(isBlockedIp("::1"));
  assert(isBlockedIp("::"));
  assert(isBlockedIp("::ffff:127.0.0.1"));
  assert(isBlockedIp("fc00::1"));
  assert(isBlockedIp("fe80::1"));
  assert(isBlockedIp("64:ff9b::169.254.169.254"));
  assert(!isBlockedIp("2001:4860:4860::8888"));
  assert(isIpLiteralHost("8.8.8.8"));
  assert(isIpLiteralHost("[::1]"));
  assert(!isIpLiteralHost("curator.example"));
});

Deno.test("http is upgraded, credentials are omitted, and a redirect hop is re-checked", async () => {
  const { deps, fetched } = depsFor((url, init) => {
    assertEquals(init?.credentials, "omit");
    assertEquals(init?.redirect, "manual");
    const headers = new Headers(init?.headers);
    assertEquals(headers.get("cookie"), null);
    assert(headers.get("user-agent")?.includes("FanFuelHub-RouteFetch"));
    if (url.startsWith("https://curator.example/")) {
      return htmlResponse("", 302, { location: "https://evil.example/meta" });
    }
    return htmlResponse(DEFAULT_FORM_PAGE_HTML);
  }, (host) => Promise.resolve(host === "evil.example" ? ["10.1.2.3"] : PUBLIC));
  const page = await fetchRoutePage("http://curator.example/submit", { deps });
  assertEquals(page.error_class, "ssrf");
  assertEquals(page.error, "blocked_ip:10.1.2.3");
  assertEquals(fetched, ["https://curator.example/submit"]);
});

Deno.test("an SSRF address on a later hop wins over the redirect cap", async () => {
  let n = 0;
  const { deps, fetched } = depsFor((_url, _init) => {
    n++;
    const next = n >= 4 ? "https://169.254.169.254/latest" : `https://hop${n}.example/next`;
    return htmlResponse("", 302, { location: next });
  }, (host) => Promise.resolve(host === "169.254.169.254" ? ["169.254.169.254"] : PUBLIC));
  const page = await fetchRoutePage("https://curator.example/start", { deps });
  assertEquals(page.error_class, "ssrf");
  assert(fetched.length >= 1);
  assert(fetched.every((u) => !u.includes("169.254.169.254")));
});

Deno.test("a body over 512 KB is truncated and the stream is cancelled", async () => {
  let cancelled = false;
  const chunk = new Uint8Array(600 * 1024);
  chunk.set(new TextEncoder().encode("<html><form action=\"/s\"><button>Submit</button></form>"));
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    },
  });
  const { deps } = depsFor(() => new Response(body, { status: 200, headers: { "content-type": "text/html" } }));
  const page = await fetchRoutePage("https://curator.example/submit", { deps });
  assertEquals(page.ok, true);
  assert(page.text_excerpt.length <= 1_500);
  assertEquals(page.signals.has_form, true);
  assertEquals(cancelled, true);
});

Deno.test("an aborted fetch is a timeout and stays deferred", async () => {
  const { deps } = depsFor((_url, init) => {
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      const abort = () => reject(new DOMException("aborted", "AbortError"));
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort);
    });
  });
  const page = await fetchRoutePage("https://curator.example/submit", { deps, timeoutMs: 40 });
  assertEquals(page.error_class, "timeout");
  assertEquals(isDeferredFetch(page), true);
  const path = await evaluateSubmissionPath(
    { submission_channel: "web_form", form_url: "https://curator.example/submit", form_source_evidence: "curator form" },
    { routeFetch: deps },
  );
  assertEquals(path.path_verified, false);
  assertEquals(path.retryable, true);
  assertEquals(path.code, "temporary_host_failure");
  assert(typeof path.retry_after === "string" && path.retry_after.length > 0);
  assertEquals(path.block_insert, undefined);
});

Deno.test("5xx and DNS failures stay deferred and do not reject the route", async () => {
  const down = routeFetchDepsReturning("nope", 503);
  const http = await evaluateSubmissionPath(
    { submission_channel: "web_form", form_url: "https://curator.example/submit", form_source_evidence: "curator" },
    { routeFetch: down },
  );
  assertEquals(http.retryable, true);
  assertEquals(http.code, "temporary_host_failure");

  const nx: RouteFetchDeps = {
    resolveHost: () => Promise.resolve([]),
    fetchImpl: () => Promise.resolve(htmlResponse(DEFAULT_FORM_PAGE_HTML)),
  };
  const dns = await evaluateSubmissionPath(
    { submission_channel: "web_form", form_url: "https://missing.example/submit", form_source_evidence: "missing" },
    { routeFetch: nx },
  );
  assertEquals(dns.retryable, true);
  assertEquals(dns.block_insert, undefined);
});

function page(over: Partial<{ status: number; html: string; text: string; final_url: string; links: string[] }>) {
  return classifyRoutePage({
    status: over.status ?? 200,
    final_url: over.final_url ?? "https://curator.example/submit",
    title: null,
    text_excerpt: over.text ?? "",
    html: over.html ?? "",
    links: over.links ?? [],
  }, { formUrl: "https://forms.example/apply" });
}

Deno.test("each rejection class and the form signals classify on their own", () => {
  const deadStatus = page({ status: 404, html: "<html>missing</html>", text: "missing" });
  assertEquals(deadStatus.dead, true);
  assertEquals(blockingSignal(deadStatus), "dead");
  const deadText = page({ text: "This page does not exist" });
  assertEquals(deadText.dead, true);

  const login = page({ text: "Please log in to continue", html: "<html><p>Please log in to continue</p></html>" });
  assertEquals(login.login_required, true);
  assertEquals(blockingSignal(login), "login_required");

  const pay = page({ text: "Submit your song for $15 credits" });
  assertEquals(pay.paywall_or_pay_to_play, true);
  const free = page({ text: "Submit your song for $0" });
  assertEquals(free.paywall_or_pay_to_play, false);

  const captcha = page({ html: "<div class=\"g-recaptcha\" data-sitekey=\"x\"></div><form></form>" });
  assertEquals(captcha.captcha, true);
  assertEquals(captcha.has_form, true);
  assertEquals(blockingSignal(captcha), "captcha");

  const follow = page({ text: "Follow to unlock the submit button" });
  assertEquals(follow.follow_gate, true);
  const closed = page({ text: "Submissions are closed for this month" });
  assertEquals(closed.submissions_closed, true);

  const form = page({ html: DEFAULT_FORM_PAGE_HTML, text: "Submit your track" });
  assertEquals(form.has_form, true);
  assertEquals(blockingSignal(form), null);
  assertEquals(form.links_to_form, false);

  const linked = page({
    html: "<html><a href=\"https://forms.example/apply\">apply</a></html>",
    text: "See the form",
    links: ["https://forms.example/apply"],
    final_url: "https://curator.example/about",
  });
  assertEquals(linked.links_to_form, true);
  assertEquals(linked.has_form, false);

  const shell = page({
    html: "<html><div id=\"root\"></div><script src=\"/app.js\"></script></html>",
    text: "Loading",
  });
  assertEquals(shell.js_only, true);
  assertEquals(shell.has_form, false);

  const builder = classifyRoutePage({
    status: 200,
    final_url: "https://form.typeform.com/to/abc",
    title: "Form",
    text_excerpt: "Loading",
    html: "<html><div id=\"root\"></div></html>",
    links: [],
  });
  assertEquals(builder.has_form, true);
  assertEquals(builder.js_only, false);
  const deadBuilder = classifyRoutePage({
    status: 404,
    final_url: "https://form.typeform.com/to/abc",
    title: null,
    text_excerpt: "missing",
    html: "<html>missing</html>",
    links: [],
  });
  assertEquals(blockingSignal(deadBuilder), "dead");
});

Deno.test("web form passes only on a fetched form, a linking source, or a form builder", async () => {
  const pass = await evaluateSubmissionPath({
    submission_channel: "web_form",
    form_url: "https://curator.example/submit",
    form_source_evidence: "unrelated blog post",
  }, { routeFetch: routeFetchDepsReturning(DEFAULT_FORM_PAGE_HTML) });
  assertEquals(pass.path_verified, true);
  assertEquals(pass.route_method, "server_fetch");
  assertEquals((pass.route_fetch as { method: string }).method, "server_fetch");
  assertEquals((pass.route_fetch as { signals: RoutePageSignals }).signals.has_form, true);

  const source = depsFor((url) => {
    if (url.includes("curator.example")) {
      return htmlResponse("<html><p>Playlist details and curator bio live here.</p></html>");
    }
    return htmlResponse("<html><a href=\"https://curator.example/submit\">submit here</a><p>The curator page is linked from this post.</p></html>");
  });
  const linked = await evaluateSubmissionPath({
    submission_channel: "web_form",
    form_url: "https://curator.example/submit",
    source_url: "https://blog.example/post",
    form_source_evidence: "hint",
  }, { routeFetch: source.deps });
  assertEquals(linked.path_verified, true, JSON.stringify(linked));
  assertEquals(source.fetched.length, 2);

  const builder = await evaluateSubmissionPath({
    submission_channel: "web_form",
    form_url: "https://form.typeform.com/to/abc",
    form_source_evidence: "hint",
  }, { routeFetch: routeFetchDepsReturning("<html><div id=\"root\"></div><script></script></html>") });
  assertEquals(builder.path_verified, true);
});

Deno.test("login, paywall, captcha, dead, follow gate, and closed submissions insert nothing", async () => {
  const cases: Array<{ html: string; status?: number; code: string }> = [
    { html: "<html><p>Please log in to continue</p></html>", code: "login_required" },
    { html: "<html><p>Pay to play. Submit for $15.</p></html>", code: "paywall_or_pay_to_play" },
    { html: "<html><form></form><div class=\"g-recaptcha\"></div></html>", code: "captcha" },
    { html: "<html><p>Page not found</p></html>", status: 404, code: "dead" },
    { html: "<html><p>Follow to unlock this download</p></html>", code: "follow_gate" },
    { html: "<html><form></form><p>Submissions are closed</p></html>", code: "submissions_closed" },
  ];
  for (const c of cases) {
    const path = await evaluateSubmissionPath({
      submission_channel: "web_form",
      form_url: "https://submitlink.io/wall",
      form_source_evidence: "submitlink host named in the agent note",
    }, { routeFetch: routeFetchDepsReturning(c.html, c.status ?? 200) });
    assertEquals(path.block_insert, true, c.code);
    assertEquals(path.code, c.code);
    assertEquals(path.path_verified, false);
  }
});

Deno.test("instagram.com is not scraped; a first-party source must name the handle", async () => {
  let fetched = 0;
  const spy: RouteFetchDeps = {
    resolveHost: () => {
      fetched++;
      return Promise.resolve(PUBLIC);
    },
    fetchImpl: () => {
      fetched++;
      return Promise.resolve(htmlResponse(DEFAULT_FORM_PAGE_HTML));
    },
  };
  const text = await evaluateSubmissionPath({
    submission_channel: "instagram_dm",
    ig_curator_account: "@curator_ok",
    ig_source_evidence: "profile bio lists DM for submissions",
  }, { routeFetch: spy });
  assertEquals(text.path_verified, true);
  assertEquals(text.route_method, "agent_text");
  assertEquals(fetched, 0);

  const igPage = await fetchRoutePage("https://www.instagram.com/curator_ok/", { deps: spy });
  assertEquals(igPage.error_class, "policy");
  assertEquals(fetched, 0);

  const named = await evaluateSubmissionPath({
    submission_channel: "instagram_dm",
    ig_curator_account: "@curator_ok",
    ig_source_evidence: "hint",
    source_url: "https://curator.example/links",
  }, { routeFetch: routeFetchDepsReturning("<html><p>DM @curator_ok on instagram.com/curator_ok</p></html>") });
  assertEquals(named.path_verified, true);
  assertEquals(named.route_method, "server_fetch");

  const miss = await evaluateSubmissionPath({
    submission_channel: "instagram_dm",
    ig_curator_account: "@curator_ok",
    ig_source_evidence: "hint",
    source_url: "https://curator.example/links",
  }, { routeFetch: routeFetchDepsReturning("<html><p>Welcome to the site.</p></html>") });
  assertEquals(miss.path_verified, false);
  assertEquals(miss.code, "ig_handle_not_on_source");
  assertEquals(miss.block_insert, undefined);
});

Deno.test("a JS shell stays unverified while the Firecrawl fallback is off", async () => {
  const shell = "<html><div id=\"root\"></div><script src=\"/app.js\"></script></html>";
  const off = await evaluateSubmissionPath({
    submission_channel: "web_form",
    form_url: "https://submitlink.io/app",
    form_source_evidence: "submitlink",
  }, { routeFetch: routeFetchDepsReturning(shell) });
  assertEquals(off.path_verified, false);
  assertEquals(off.code, "js_render_required");
  assertEquals(off.block_insert, undefined);

  const setting = { enabled: true, daily_cap: 25, used_date: null as string | null, used_count: 0 };
  const sb = {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: { setting_value: setting }, error: null }),
        }),
      }),
      update: (row: { setting_value: typeof setting }) => ({
        eq: () => {
          Object.assign(setting, row.setting_value);
          return Promise.resolve({ error: null });
        },
      }),
    }),
  };
  const rendered = await evaluateSubmissionPath({
    submission_channel: "web_form",
    form_url: "https://submitlink.io/app",
    form_source_evidence: "submitlink",
  }, {
    sb: sb as never,
    routeFetch: {
      ...routeFetchDepsReturning(shell),
      firecrawlRender: () => Promise.resolve({ html: DEFAULT_FORM_PAGE_HTML, markdown: "Submit your track" }),
    },
  });
  assertEquals(rendered.path_verified, true, JSON.stringify(rendered));
  assertEquals(setting.used_count, 1);

  setting.used_count = 25;
  setting.used_date = new Date().toISOString().slice(0, 10);
  const capped = await renderJsPage(sb as never, "https://submitlink.io/app", { now: () => new Date() });
  assertEquals(capped, null);
  assertEquals(parseFirecrawlFallbackSetting({ enabled: false, daily_cap: 25 }).enabled, false);
});

Deno.test("manual re-verify stores the server fetch and does not trust agent text alone", async () => {
  const row: Record<string, unknown> = {
    playlist_id: "boom102",
    verification_status: "manually_verified",
    path_verified: false,
    contact_method: "web_form",
    submission_method: "web_form",
    form_url: "https://play.soundplate.com/boom102",
    form_source_evidence: "old note",
    research_context: { lane: "boom_bap" },
  };
  const writes: Record<string, unknown>[] = [];
  const sb = {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: row, error: null }) }) }),
      update: (patch: Record<string, unknown>) => {
        writes.push(patch);
        return { eq: () => Promise.resolve({ error: null, count: 1 }) };
      },
    }),
  } as unknown as Parameters<typeof reverifyManuallyVerifiedTarget>[0];
  const res = await reverifyManuallyVerifiedTarget(sb, playlistDiscoveryActor(), {
    playlistId: "boom102",
    evidence: "Free submit link.",
    candidate: {
      submission_channel: "web_form",
      form_url: "https://play.soundplate.com/boom102",
      source_url: "https://soundplate.com/post",
    },
    routeFetch: routeFetchDepsReturning(DEFAULT_FORM_PAGE_HTML),
  });
  assert(res.ok && res.reverified, JSON.stringify(res));
  const rc = writes[0].research_context as Record<string, unknown>;
  assertEquals((rc.route_fetch as { method: string }).method, "server_fetch");
  assertEquals(rc.route_verified_by, "server_fetch");
  assertEquals(rc.source_url, "https://soundplate.com/post");
});

Deno.test("structural Grok codes block the same route and fit codes do not", () => {
  assert(isStructuralRouteRejection("LOGIN_REQUIRED/PAYWALL_POOL"));
  assert(isStructuralRouteRejection("login_only"));
  assert(isStructuralRouteRejection("PAY_TO_PLAY"));
  assert(isStructuralRouteRejection("CAPTCHA_BLOCK"));
  assert(isStructuralRouteRejection("DEAD_FORM_URL"));
  assert(isStructuralRouteRejection("FOLLOW_GATE"));
  assert(!isStructuralRouteRejection("DNA_LANE_MISMATCH"));
  assertEquals(emptySignals().dead, false);

  const same = priorStructuralRouteBlock([
    {
      id: "r1",
      submission_channel: "web_form",
      rejection_reason: "LOGIN_REQUIRED/PAYWALL_POOL",
      packet: { form_url: "https://submitlink.io/form" },
    },
  ], { channel: "web_form", form_url: "https://www.submitlink.io/other" });
  assertEquals(same?.record_id, "r1");

  const otherHost = priorStructuralRouteBlock([
    {
      id: "r1",
      submission_channel: "web_form",
      rejection_reason: "DEAD_FORM",
      packet: { form_url: "https://submitlink.io/form" },
    },
  ], { channel: "web_form", form_url: "https://curator.example/submit" });
  assertEquals(otherHost, null);

  const fit = priorStructuralRouteBlock([
    {
      id: "r2",
      submission_channel: "web_form",
      rejection_reason: "DNA_LANE_MISMATCH",
      packet: { form_url: "https://submitlink.io/form" },
    },
  ], { channel: "web_form", form_url: "https://submitlink.io/form" });
  assertEquals(fit, null);
});
