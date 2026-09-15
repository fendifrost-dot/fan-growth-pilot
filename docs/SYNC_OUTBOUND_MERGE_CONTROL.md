# Sync professional-email outbound — merge traffic control

**Controller:** Cursor agent `bc-1f487a2e-49af-57c4-962b-a168c1b14ad4`  
**Canonical repo:** `fendifrost-dot/fan-growth-pilot` @ `main` (`770b7c1` at audit start)  
**This document is an audit + merge-order package.** It does not implement sync send.

Do **not**: Lovable chat, live email sends, force-push `main`, or fold unrelated playlist/DNA PRs into this lane.

---

## Concurrent lane (authorized 2026-09-15)

| Role | Agent | Expected product |
|------|--------|------------------|
| **Map** sync vs playlist Resend | [Map sync vs playlist Resend send path](https://cursor.com/agents/bc-01794a17-f3be-52df-b713-14c28d827d71) | Path map (docs / comments). Prefer **no production send-path edits**. |
| **Implement** sync business-domain outbound | [Sync Resend business From send path](https://cursor.com/agents/bc-ee51a93c-2b39-52d1-9d65-37b4cbc1c702) | Isolated sync From + logging. Must not change playlist send. |
| **Audit / merge traffic** (this branch) | [Audit + merge traffic sync send](https://cursor.com/agents/bc-1f487a2e-49af-57c4-962b-a168c1b14ad4) | Checklist, collision map, sequential merge order, greenlight or reconcile. |

At audit start, mapper and implementer had **no branches and no PRs**. Re-check `gh pr list` and remote branches before merging anything.

---

## Merge order (required)

Prefer **small sequential merges**. Do not land a mega-PR that rewrites playlist + sync together.

1. **Mapper PR (docs-only)** — merge first if it is accurate and does not edit senders.  
   If the mapper also changes code, treat that code as **out of order**: park it or fold only the facts into this file.
2. **Implementer PR (sync From + sync logging only)** — merge second, after this checklist is green.  
   Rebase onto `main` after the mapper merge (or onto `main` directly if the mapper PR is comments-only).
3. **Coordinator reconcile PR** — only if mapper + implementer collide on the same files.  
   Resolve conflicts here; do not force-push either sibling branch.
4. **Lovable apply (human)** — after merge: paste any new migration in Lovable SQL Editor; redeploy **only** the functions the implementer names. Do not redeploy playlist senders unless their diff is empty.

**Do not merge into this lane**

| PR | Title | Why parked |
|----|--------|------------|
| [#24](https://github.com/fendifrost-dot/fan-growth-pilot/pull/24) | playlist batch `drafted_by` | Playlist attribution. Touches CCA / discovery. Unrelated. |
| [#13](https://github.com/fendifrost-dot/fan-growth-pilot/pull/13) | Complete AGH stack (draft) | Mega-stack. Stale vs `main`. Would collide. |
| [#12](https://github.com/fendifrost-dot/fan-growth-pilot/pull/12) | Song DNA PostgREST embed | Already live on `main`. Close, do not merge. |
| [#8](https://github.com/fendifrost-dot/fan-growth-pilot/pull/8) | Phase 0 locked decisions | Stale vs later merged outreach work. |

---

## Baseline on `main` (pre-implementer)

### Two live Resend families

| Lane | Entry | Transport | Default From | Operator log |
|------|--------|-----------|--------------|--------------|
| **Playlist curator** | `execute-pitch`, `send-pitch-email` | `resend-pitch.ts` (`sendResendEmail` / inline Resend) | `FROM_EMAIL` → `pitches@fendifrost.com` | `pitch_log` (`resend_message_id`, subject, body, draft bind) |
| **Sync outreach** | CCA `submit_sync_outreach` → `sync-control.ts` | `provider-transport.ts` `sendProviderEmail` | **same** `FROM_EMAIL` → `pitches@fendifrost.com` | Draft row + `submission_message_id` only. **No `licensing_pitch_log` write.** |
| **Split-sheet delivery** | split-sheet delivery | **same** `sendProviderEmail` | **same** `FROM_EMAIL` | `split_sheet_deliveries` |
| **Fan campaigns** | `send-campaign-email` | own Resend call | `campaign.from_email` | campaign send log |

Shared env `FROM_EMAIL` is the primary collision. Changing its default or meaning to “business domain” would retarget **playlist + split-sheet** From headers.

### Confirmed gaps (implementer must close — or document why not)

1. **Sync From is playlist From.** `sendProviderEmail` has no `from` argument and no `SYNC_FROM_EMAIL` / business-domain secret. Sync supervisors currently receive mail as `Fendi Frost <pitches@fendifrost.com>`.
2. **`licensing_pitch_log` is manual-only.** `log_licensing_pitch` in `sync-registers.ts` inserts operator-entered rows. `submit_sync_outreach` never writes the table. Schema has no `resend_message_id`, `from_email`, `draft_id`, or `dispatched_via`.
3. **Gmail still hardcoded on playlist test path.** `execute-pitch` defaults `test_email` to `fendifrost@gmail.com`. Must not become a sync From. Docs (`FENDIFROST_RESEND_DNS_DELIVERABILITY.md`) still describe Gmail Reply-To; code default Reply-To is `replies@fendifrost.com`.
4. **Caller From spoofing is currently blocked** (good). Transport builds From from env only. Implementer must keep it that way — no `body.from` / `body.from_email`.

### Song-title hardcoding (do not regress)

Production send/routing must stay ID-driven (`ops_settings.sync_research_config` track UUIDs). `Meditate` / `Designed For Me` literals belong in **tests and config labels**, not send-path branches. Existing guards: `song-dna-enforcement.test.ts`, `lane-routing-request-path.test.ts`, `outreach-cutover-acceptance.test.ts` (`isMeditateTitle` forbidden in sync-registers).

---

## Collision surfaces (watch these files)

**Implementer may touch (narrow):**

- `supabase/functions/_shared/provider-transport.ts` — only if From becomes an **optional argument** with playlist/split-sheet defaults unchanged
- `supabase/functions/_shared/sync-control.ts` — pass business From; write `licensing_pitch_log`
- `supabase/functions/_shared/sync-registers.ts` — only if logging helpers are shared
- New helper e.g. `_shared/sync-resend.ts` (preferred over editing `resend-pitch.ts`)
- `supabase/migrations/*` — additive columns on `licensing_pitch_log`
- Tests next to those modules

**Mapper may touch (docs only preferred):**

- `docs/*` path map
- Comments on the files above

**Red zone — treat as playlist-break unless diff is empty/comment-only:**

- `supabase/functions/execute-pitch/index.ts`
- `supabase/functions/send-pitch-email/index.ts`
- `supabase/functions/_shared/resend-pitch.ts`
- `supabase/functions/_shared/playlist-agent-run.ts`
- Default `FROM_EMAIL` / `REPLY_TO_EMAIL` semantics
- Song DNA / playlist discovery / PR #24 attribution files

**Yellow zone — CCA router:**

- `supabase/functions/control-center-api/index.ts` already dispatches `runSyncControlAction`. Prefer zero CCA edit. If CCA must change, do not take playlist-agent or DNA diffs in the same PR.

---

## Audit checklist (implementer PR)

Reviewer fills this on the implementer PR before greenlight.

### Secrets / leakage

- [ ] No API keys, service-role material, or webhook secrets in the diff
- [ ] Provider errors stay sanitized (`sanitizeProviderError` or equivalent)
- [ ] Tests do not log full Resend payloads with Authorization headers

### From / domain / spoofing

- [ ] Sync From is a **verified `@fendifrost.com` business mailbox** (or env with that default), not Gmail
- [ ] Sync From is **not** `pitches@fendifrost.com` unless Fendi explicitly reused that mailbox
- [ ] Playlist path still defaults `FROM_EMAIL` → `pitches@fendifrost.com`
- [ ] Split-sheet delivery From unchanged unless a dedicated secret is documented
- [ ] No caller-supplied `from` / `from_email` / display-name override
- [ ] Reply-To is on-domain (or existing `REPLY_TO_EMAIL`); not hardcoded `fendifrost@gmail.com` as From

### Song identity

- [ ] No production `if (title === "Meditate")` (or DFM) send/From/logging branch
- [ ] Track identity from `track_id` / approved draft / eligibility decision

### Playlist send integrity

- [ ] `execute-pitch` / `send-pitch-email` / `resend-pitch.ts` / `playlist-agent-run` diff empty or comment-only
- [ ] Playlist `pitch_log` shape and draft-bind gates unchanged
- [ ] No shared helper change that alters playlist subject/From/Reply-To/HTML

### Logging

- [ ] Successful sync email writes `licensing_pitch_log` (or a documented equivalent operator table)
- [ ] Provider message id stored (new column or existing draft `submission_message_id` **and** operator log)
- [ ] From address recorded or reconstructible from env name + deploy note
- [ ] Failed send does not insert a `sent` licensing row
- [ ] Manual `log_licensing_pitch` still works

### Auth / send safety

- [ ] `submit_sync_outreach` still capability-gated (Grok/Fendi; Claude denied)
- [ ] Eligibility gate still runs before Resend
- [ ] Test mode / `AGH_PROVIDER_TEST_MODE` still skips live Resend
- [ ] No live send in CI

### Scope

- [ ] No Song DNA, playlist discovery, or campaign rewrite
- [ ] Migration is additive (Lovable SQL Editor paste; not CLI apply)

---

## Greenlight rule

**Greenlight** the implementer PR only when every box above is checked or explicitly waived in a review comment with reason.

**Block** (do not merge) if any of: secrets in tree, Gmail From, title-hardcoded send, playlist sender behavior change, caller From spoof, successful send without durable log, live send in tests.

**Reconcile** on this controller branch if both siblings edit the same send helper. Sequential rebase: mapper facts → implementer code → this checklist update.

---

## Redeploy note (after a greenlit merge)

Human-only, via Lovable — not `supabase functions deploy`:

1. Paste migration (if any) into Lovable SQL Editor.
2. Set the new sync From secret if introduced (`SYNC_FROM_EMAIL` or named equivalent). **Do not** retarget `FROM_EMAIL` unless the implementer PR proves playlist still uses `pitches@`.
3. Redeploy `control-center-api` (and any new/changed sync helper bundled with it).
4. **Do not** redeploy `execute-pitch` / `send-pitch-email` unless those files are untouched and a human still wants a no-op refresh — default is skip.

---

## Status log

| When | State |
|------|--------|
| 2026-09-15 audit start | `main` = `770b7c1`. No mapper/implementer PR yet. Baseline gaps documented. Lane PRs #8/#12/#13/#24 parked. |
