# CURSOR TASK — AGH verifies submission routes itself (server-side route fetch)

Owner: **Cursor**. Requested by Fendi 2026-10-13. Written against `main` @ `9994b36`.
Read `CLAUDE.md` + `docs/AGENT_BOOTSTRAP.md` first: Lovable-managed backend only. Edge functions
redeploy via **Lovable → Edge Functions**; SQL goes through the **Lovable SQL editor**; no Supabase CLI.

Status of this doc: **a spec, nothing built.** Do not mark any item done without the
verification output in §6.

---

## 1. Why

Today a playlist's submission route (web form / IG DM) is verified by text matching on
evidence that **Claude** collected with its own WebFetch:

- `submit_playlist_candidates` → `evaluateSubmissionPath` (`_shared/multichannel-path.ts:81`)
  → `assessSubmissionRoute` (`_shared/submission-route.ts:153`).
- The web-form check is `evidenceSupportsForm(formUrl, evidence, sourceUrl)`
  (`submission-route.ts:115`). It passes if the form's host label appears in Claude's
  evidence string or matches `source_url`'s host. **The server never loads either page.**
- The packet is stamped `route_verification.method = "server_route_rules"`
  (`playlist-discovery-mcp.ts` ~1985), but those rules only ever saw Claude's text.

That creates two problems:

1. **Unattended runs break.** Claude's WebFetch on curator domains that aren't
   pre-approved asks for a permission click. In scheduled runs nobody answers it, and the
   request is withdrawn (`PROVENANCE_REQUIRED`). Examples: musicto.com, open.spotify.com
   playlist pages. Route verification stalls. Auto mode now covers this, but the gate
   lives in the agent's permissions, not in AGH, so it can come back with any permission change.
2. **Drafts Grok will reject still get created.** The 10-13 reconciliation
   (`docs/HANDOFF_AGH_QUEUE_RECONCILIATION_2026-10-13.md`) found:
   - 41 pending records re-drafted on the **same route** Grok already rejected, for
     `login_only`, `LOGIN_REQUIRED/PAYWALL_POOL`, `PAY_TO_PLAY`, `CAPTCHA_BLOCK`,
     `DEAD_FORM` and `FOLLOW_GATE`;
   - 22 more on hosts with 0 lifetime approvals (submitlink.io, dailyplaylists.com,
     submithub.com).

   A server that loads the page can see a login wall, paywall, captcha or 404 before
   anything reaches Grok's queue.

## 2. Goal

AGH fetches the curator's page itself and records machine evidence of the route.
Claude's evidence text becomes a hint, not the proof. Verification works the same
attended or unattended, with no permissions held by any agent.

## 3. Scope

### Part A — required: server-side route fetch

1. **New module `supabase/functions/_shared/route-fetch.ts`.**
   - `fetchRoutePage(url, opts)` returns
     `{ ok, final_url, status, content_type, title, text_excerpt, links[], signals, fetched_at, error }`.
     It does a plain `fetch` with a timeout of about 8s, at most 3 redirects, a body cap of
     about 512 KB, no cookies and no credentials. The User-Agent identifies FanFuel Hub.
   - **SSRF guard (mandatory).** Allow `https:` only (allow `http:` only if you upgrade it).
     Resolve the host and refuse loopback, private, link-local and metadata ranges, both
     IPv4 and IPv6. Refuse IP-literal hosts. Re-check every redirect hop.
     Unit-test each refusal.
   - `classifyRoutePage(page)` is a pure function that returns signals:
     - `dead` (404/410, DNS fail, "page not found")
     - `login_required` (login/sign-in wall, OAuth redirect)
     - `paywall_or_pay_to_play` (price, checkout, "credits", "$" + submit)
     - `captcha` (hCaptcha / reCAPTCHA / Turnstile markers)
     - `follow_gate` (ToneDen / hypeddit / "follow to unlock")
     - `submissions_closed`, reusing `NEGATED_ROUTE_EVIDENCE`
     - `has_form` (a `<form>`, or a known form-builder embed / `FORM_BUILDER_HOSTS`)
     - `links_to_form` (the source page links to `form_url`'s host)

     Keep the phrase lists next to the existing ones in `submission-route.ts`.

2. **Use it in verification.** Every path into `evaluateSubmissionPath` for `web_form` and
   `instagram_dm` should fetch server-side. That covers new candidates and
   `reverifyManuallyVerifiedTarget` (`playlist-discovery-mcp.ts` ~675).
   - **web_form:** fetch `form_url`. Also fetch `source_url` when it is given and on a
     different host. Pass only when the form page is not
     `dead` / `login_required` / `paywall_or_pay_to_play` / `captcha` / `follow_gate` /
     `submissions_closed`, **and** one of these holds:
     - (a) the form page `has_form` on the same host label;
     - (b) the source page `links_to_form`;
     - (c) the host is a hosted form builder.
   - **instagram_dm:** do **not** scrape instagram.com, since it requires login and that
     breaks the no-login rule. Instead fetch `source_url` (the curator's own site or
     link-in-bio) and require that it names the handle. If there is no first-party
     `source_url`, keep today's text rule and mark the evidence as `agent_text`.
   - **email:** unchanged (MX/format plus bounce suppression).
   - A **fetch failure** (timeout, 5xx, network) returns `deferred` with a retry-after.
     That matches the existing "temporary host failure, resubmit later" contract in the
     `submit_playlist_candidates` description, and it is **not** a rejection.

3. **Store the evidence.** Write a `route_fetch` object into
   `playlist_targets.research_context`, with no new column. It should contain:
   `{ method: "server_fetch", fetched_at, final_url, status, signals, title }`.
   Stamp the packet's `route_verification.method` as `server_fetch` when the fetch decided
   the route; otherwise `server_route_rules`, so old records stay comparable.
   Do not store page bodies, only the excerpt and signals.

4. **Keep the database rule consistent.** `agh_route_failure_code(...)`
   (`migrations/20260927120000_route_hold_and_candidate_log.sql:22`) and
   `agh_route_recertify_targets` re-derive route validity in SQL. Make sure a target that
   passes via `server_fetch` is not demoted by them. If that needs SQL, add a **new
   migration**; never edit an applied one. It is applied in the Lovable SQL editor, and the
   expected result (function replaced, 0 rows changed) goes in the PR.

5. **Tests (Deno, `_shared/*.test.ts`).** Stub `fetch`; no live network in CI.
   - one fixture per signal;
   - the SSRF refusals;
   - redirect re-check;
   - timeout returns `deferred`;
   - the `evaluateSubmissionPath` web-form pass/fail matrix;
   - IG `source_url` names the handle;
   - an existing manually_verified re-verify still works.

   CI command: `deno test --no-check --allow-env --allow-read <all _shared/*.test.ts except *.live.test.ts>`.

### Part B — optional, same intake gate (do it only if Part A is green)

Stop re-drafting a (track, playlist) pair whose previous record on the **same route** was
`REJECTED_BY_GROK` with a **structural** code (login/paywall/pay-to-play/captcha/dead
form/follow gate). Return a clear `prior_structural_rejection` outcome instead.

- **Fit rejections are out of scope.** They have their own requeue path
  (`agh_fit_rejection_requeue`); leave it alone.
- A pair whose route **changed** (a different `form_url` host) may proceed.

### Out of scope / do not touch

- Approval, sending, cooldowns, deduplication, contact policy, song-fit / DNA lanes.
  Server fetch only *verifies*; it never approves or sends.
- Soundplate stays frozen. The Worldstar lofi cooldown and its fit caveat stay as they are.
- `usable_inflight` / discovery headroom math (`playlist-funnel.ts`). That is a separate,
  pending Fendi decision.
- Existing records. **No backfill or bulk re-verification in this task.** If you want one,
  write a dry-run SQL with expected counts and get Fendi's go-ahead.

## 4. Spending — decision for Fendi, default OFF

`_shared/firecrawl.ts` exists, and `FIRECRAWL_API_KEY` is used by `playlist-research`.
Firecrawl renders JS-heavy forms (submitlink, typeform embeds) that a plain `fetch` misses,
but **it costs credits**. Build a Firecrawl fallback behind an ops setting,
`route_fetch_firecrawl_fallback`, that defaults to `false`, plus a per-day cap. When the
setting is off and the plain fetch is inconclusive (JS-only page), the result is
`accepted_unverified` with the reason `js_render_required`, never a pass.

## 5. Deploy

1. Merge the PR to `main`.
2. **Lovable → Edge Functions → redeploy** `mcp-playlist-discovery`. Also redeploy any other
   function that imports `multichannel-path.ts` or `submission-route.ts`. Grep the imports
   and list each function you redeployed, by name, in the PR.
3. Lovable SQL editor: only if §3.A.4 needed a migration.
4. Publish is **not** required. No frontend changes.

## 6. Verification (paste the real output; do not mark done without it)

Run each check through the AGH Playlist Discovery MCP (`submit_playlist_candidates`), in
an **unattended** Claude run (Auto mode is fine; the point is that no agent fetch is involved).

| Case | Input | Expected |
|---|---|---|
| Live free form | a known-good free form (e.g. the `sbmt.to/airbender` route Grok approved 10-13) | `verified_eligible`, `route_verification.method = "server_fetch"`, `research_context.route_fetch.status = 200` |
| Login wall | a submitlink.io URL Grok rejected as `LOGIN_REQUIRED/PAYWALL_POOL` | rejected with `login_required` or `paywall_or_pay_to_play`; **no draft created** |
| Dead form | a Google Form rejected `DEAD_FORM_URL` | rejected with `dead` |
| Unreachable host | an unresolvable domain | `deferred` with retry-after, not rejected |
| SSRF | `https://127.0.0.1/`, `http://169.254.169.254/` | refused before any fetch |

Cheap check that it is deployed: submit the login-wall case. **Old code** will accept it
when Claude's evidence names the host. **New code** returns `login_required`. Either result
is a real finding; report it as-is.

Then, for one week, compare `REJECTED_BY_GROK` codes on **new** records against the week
before. A fall in login/paywall/captcha/dead-form rejections is the success signal.
A rising count of `accepted_unverified / js_render_required` means the Firecrawl
decision in §4 needs to go back to Fendi.

## 7. Guardrails

- Don't widen this PR into approval, send or headroom logic.
- Don't edit an applied migration to make it run. If a migration errors, the live DB
  differs from the repo, and that is the finding to report.
- Don't scrape Instagram or anything behind a login.
- Don't loosen a rule to make a verification case pass.

## 8. Report back

PR link and merge SHA; the redeployed function names and times; the §6 table filled in
with real responses; any migration applied and its exact output.
