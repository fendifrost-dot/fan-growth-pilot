# Sync professional-email outbound — merge traffic control

**Controller:** Cursor agent `bc-1f487a2e-49af-57c4-962b-a168c1b14ad4`  
**Canonical repo:** `fendifrost-dot/fan-growth-pilot`  
**Lane status: COMPLETE on `main`.** Sequential merges landed without a reconcile PR.

| Step | Merge | SHA |
|------|-------|-----|
| #32 map | 2026-09-16T05:18Z | `c95b3a7` |
| #34 implement (greenlit `eed709c`, landed `86c6b84`) | 2026-09-16T05:19Z | `2febf56` |

Collide resolution on `main` matches the order: map doc from #32; `.env.example` + flipped `sync-playlist-outbound-gap.test.ts` from #34.

**Remaining (human / Lovable, not git):** paste `20260916000000_licensing_pitch_log_hub_send.sql`; optional `SYNC_FROM_EMAIL`; redeploy `control-center-api` + publish frontend. Do not redeploy `execute-pitch`. This controller PR can close.

Do **not**: Lovable chat, live email sends, force-push `main`, or fold unrelated playlist/DNA PRs into this lane.

---

## Concurrent lane (authorized 2026-09-15)

| Role | Agent | Expected product |
|------|--------|------------------|
| **Map** sync vs playlist Resend | [Map sync vs playlist Resend send path](https://cursor.com/agents/bc-01794a17-f3be-52df-b713-14c28d827d71) | Path map (docs / comments). Prefer **no production send-path edits**. |
| **Implement** sync business-domain outbound | [Sync Resend business From send path](https://cursor.com/agents/bc-ee51a93c-2b39-52d1-9d65-37b4cbc1c702) | Isolated sync From + logging. Must not change playlist send. |
| **Audit / merge traffic** (this branch) | [Audit + merge traffic sync send](https://cursor.com/agents/bc-1f487a2e-49af-57c4-962b-a168c1b14ad4) | Checklist, collision map, sequential merge order, greenlight or reconcile. |

Mapper product is [#32](https://github.com/fendifrost-dot/fan-growth-pilot/pull/32) (`docs/SYNC_VS_PLAYLIST_OUTBOUND_GAP.md` + `sync-playlist-outbound-gap.test.ts`). That map is the path-of-record. Implementer must extend the existing CCA path, not invent `execute-sync-pitch`.

---

## Merge order (required)

Prefer **small sequential merges**. Do not land a mega-PR that rewrites playlist + sync together.

1. **Mapper PR (docs-only)** — merge first if it is accurate and does not edit senders.  
   If the mapper also changes code, treat that code as **out of order**: park it or fold only the facts into this file.
2. **[#34](https://github.com/fendifrost-dot/fan-growth-pilot/pull/34) implementer (`eed709c`)** — **greenlight.** Merge second. Rebase onto #32; on the two colliding files (`.env.example`, `sync-playlist-outbound-gap.test.ts`) **keep #34**. #32's unique file is the map doc.
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

### Baseline blockers (greenlight only when all four are closed)

Confirmed by #32 and the original `main` audit. Implementer **must** close these:

1. **No Hub Submit door.** `/admin/licensing` only records via `log_licensing_pitch`. Claude MCP cannot submit. Grok/Fendi can call CCA `submit_sync_outreach`, but there is no operator **Submit via Hub** button. That is why recent sync mail left from Gmail (side-channel compose), not because Resend is missing.
2. **`licensing_pitch_log` is record-only.** `submit_sync_outreach` never writes it. Schema has no `resend_message_id`. A register row with `status=sent` can hide a Gmail compose.
3. **Playlist From must stay untouched.** Shared `FROM_EMAIL` default `pitches@fendifrost.com` is the warmed playlist identity. Do not retarget it for sync.
4. **Gmail must never be From.** Reply-To may be Gmail / `replies@`. `execute-pitch` `test_email` defaulting to `fendifrost@gmail.com` is playlist-only and must not be copied onto sync From.

**Not a merge blocker (optional, preferred):** `SYNC_FROM_EMAIL` (e.g. `sync@fendifrost.com`) used only by `submitSyncOutreach`, falling back to `FROM_EMAIL`. Short-term From of `pitches@` is already a business domain — #32 says keep it until the mailbox exists. Dedicated local-part is reputation isolation, not the professional-From requirement.

**Keep (already true on `main`):** caller From spoofing is impossible (env-only). Do not add `body.from`.

### Song-title hardcoding (do not regress)

Production send/routing must stay ID-driven (`ops_settings.sync_research_config` track UUIDs). `Meditate` / `Designed For Me` literals belong in **tests and config labels**, not send-path branches. Existing guards: `song-dna-enforcement.test.ts`, `lane-routing-request-path.test.ts`, `outreach-cutover-acceptance.test.ts` (`isMeditateTitle` forbidden in sync-registers).

---

## Collision surfaces (watch these files)

**Implementer may touch (steered, narrow):**

- `src/pages/admin/AdminLicensing.tsx` (or new `AdminSyncOutreach.tsx`) — pending drafts + **Submit via Hub** → `callHubFn("submit_sync_outreach")` (and list/approve actions already on CCA)
- `src/lib/hubApi.ts` — only if a typed wrapper is required
- `supabase/functions/_shared/sync-control.ts` — after provider accept, write `licensing_pitch_log` with `resend_message_id`
- `supabase/functions/_shared/sync-registers.ts` — do not default external `log_licensing_pitch` to `sent` without evidence (Phase 3 in #32)
- `supabase/functions/_shared/provider-transport.ts` — optional `from` argument or `SYNC_FROM_EMAIL` read **only** from `submitSyncOutreach`; default From/Reply-To for other callers unchanged
- `supabase/migrations/*` — additive `resend_message_id` (+ subject/body/draft_id/dispatched_via if following #32 Phase 3)
- `src/integrations/supabase/types.ts` — generated column types
- `supabase/functions/_shared/sync-playlist-outbound-gap.test.ts` — **must update** #32 gap-locks when gaps close
- Tests next to those modules

**Out of steered scope (do not require for greenlight):** new `execute-sync-pitch` edge, Grok MCP submit tools, `resend-webhook` sync bounce matching (nice follow-up).

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

## Audit checklist (implementer PR) — locked to #32 + steered scope

Reviewer fills this on the implementer PR. **Greenlight only when every required box is checked.**

### Required — Submit via Hub (closes Gmail side-channel)

- [ ] Admin UI lists pending sync drafts and has **Submit via Hub**
- [ ] That button calls existing CCA `submit_sync_outreach` (via `callHubFn`), not a new edge, not Resend from the browser
- [ ] Claude MCP still cannot submit
- [ ] Record-only `log_licensing_pitch` remains available for true external mail and does **not** call Resend

### Required — `licensing_pitch_log` + `resend_message_id`

- [ ] Additive migration adds `resend_message_id` (and #32 Phase 3 extras if present)
- [ ] After provider **accept**, `submitSyncOutreach` inserts/upserts `licensing_pitch_log` with that id (`test_…` in test mode)
- [ ] Failed send does **not** insert a `sent` licensing row
- [ ] Draft row still gets `submission_message_id` (existing contract)
- [ ] #32 gap-lock `submit must not yet write licensing_pitch_log` is updated, not deleted without replacement

### Required — From identity

- [ ] **No Gmail From** in code defaults, UI, or tests that set production From
- [ ] **No playlist From changes:** `execute-pitch` / `send-pitch-email` / `resend-pitch.ts` / `FROM_EMAIL` default `pitches@fendifrost.com` unchanged
- [ ] Split-sheet callers of `sendProviderEmail` still get the existing default unless they opt in
- [ ] No caller-supplied `from` / `from_email` / display-name override
- [ ] If `SYNC_FROM_EMAIL` is wired: optional; used only on sync submit; fallback is `FROM_EMAIL` / `pitches@`; never Gmail

### Required — safety / scope

- [ ] No API keys or service-role material in the diff
- [ ] Provider errors stay sanitized
- [ ] `submit_sync_outreach` still Grok/Fendi-only; eligibility still runs before Resend
- [ ] `AGH_PROVIDER_TEST_MODE` still skips live Resend; no live send in CI
- [ ] No song-title send/From/logging branch
- [ ] No Song DNA, playlist discovery, campaign, or #24 attribution rewrite

### Optional (do not block merge)

- [ ] `SYNC_FROM_EMAIL` default documented as `sync@` once the mailbox exists (ops: Resend identity + Cloudflare routing)
- [ ] `resend-webhook` matches licensing / sync message ids
- [ ] Dedicated `execute-sync-pitch` edge — **not requested**; reject if it reimplements send
- [ ] Grok MCP submit tools

---

## Greenlight rule

**Greenlight** the implementer PR only when every **required** box above is checked or explicitly waived in a review comment with reason.

**Block** (do not merge) if any of: no Submit via Hub on `submit_sync_outreach`, successful Hub send without `licensing_pitch_log.resend_message_id`, Gmail From, playlist From/`FROM_EMAIL` change, caller From spoof, secrets in tree, title-hardcoded send, live send in tests. Missing optional `SYNC_FROM_EMAIL` is **not** a block if From stays `@fendifrost.com` via `FROM_EMAIL`.

**Reconcile** on this controller branch if both siblings edit the same send helper. Sequential rebase: mapper facts → implementer code → this checklist update.

---

## Redeploy note (after a greenlit merge)

Human-only, via Lovable — not `supabase functions deploy`:

1. Paste migration (if any) into Lovable SQL Editor.
2. Set the new sync From secret if introduced (`SYNC_FROM_EMAIL` or named equivalent). **Do not** retarget `FROM_EMAIL` unless the implementer PR proves playlist still uses `pitches@`.
3. Redeploy `control-center-api` (and any new/changed sync helper bundled with it).
4. **Do not** redeploy `execute-pitch` / `send-pitch-email` unless those files are untouched and a human still wants a no-op refresh — default is skip.

---

## Traffic now

| PR | Role | Audit | Merge |
|----|------|-------|-------|
| [#32](https://github.com/fendifrost-dot/fan-growth-pilot/pull/32) | Mapper | **Pass.** Unique value: `docs/SYNC_VS_PLAYLIST_OUTBOUND_GAP.md`. | **Merge first.** On collide with #34, keep #32's **doc**; take #34's **test + `.env.example`**. |
| [#34](https://github.com/fendifrost-dot/fan-growth-pilot/pull/34) `eed709c` | Implementer | **Greenlight.** All required boxes + optional `SYNC_FROM_EMAIL`. CI green. | **Merge second.** Rebase onto #32; keep this branch's gap tests. |
| [#33](https://github.com/fendifrost-dot/fan-growth-pilot/pull/33) | Playlist `drafted_by` | Out of lane | Separate. |
| [#31](https://github.com/fendifrost-dot/fan-growth-pilot/pull/31) (this) | Controller | Checklist | Close after #32+#34 land, or keep as traffic log. |

**Still parked:** #24 / #13 / #12 / #8. A new playlist `drafted_by` agent is also out of this lane.

### #32 review notes (2026-09-15)

Passed checklist items that apply to a map PR:

- No secrets in tree (secret **names** only; actor tests use dummy header values)
- No Gmail From; `.env.example` now says From is never Gmail, Reply-To may be Gmail
- No song-title send hardcoding
- Playlist senders untouched (`execute-pitch`, `resend-pitch.ts`, `playlist-agent-run`)
- No caller From spoofing introduced
- Correctly documents missing `licensing_pitch_log` on Hub submit
- No live Resend in tests

#34 `eed709c` now **owns the flipped** `sync-playlist-outbound-gap.test.ts`. After #32 merges, keep #34's copy of that file. Webhook remaining playlist-only is still an intentional Phase-4 gap.

#32 From guidance (now the locked recommendation): short-term keep `pitches@` via `FROM_EMAIL`; preferred later `SYNC_FROM_EMAIL=sync@fendifrost.com`; never Gmail From. Principal steer matches: **optional** `SYNC_FROM_EMAIL`, required Hub Submit + licensing `resend_message_id`.

---

## Status log

| When | State |
|------|--------|
| 2026-09-15 audit start | `main` = `770b7c1`. No mapper/implementer PR yet. Baseline gaps documented. Lane PRs #8/#12/#13/#24 parked. |
| 2026-09-15 mapper landed | [#32](https://github.com/fendifrost-dot/fan-growth-pilot/pull/32) reviewed. **Merge-first approved.** |
| 2026-09-15 checklist lock | Checklist rewritten against #32 + steered implementer scope. **Implementer not greenlit** until Hub Submit + `licensing_pitch_log.resend_message_id` land without playlist/Gmail From changes. |
| 2026-09-16 #34 review | First #34 pass: **conditional** (alias + stale gap-locks). |
| 2026-09-16 #34 `eed709c` | Re-audit. **Greenlight.** Alias removed; UI calls `submit_sync_outreach`; gap tests flipped; `SYNC_FROM_EMAIL` env-only + Gmail rejected; `resend-pitch.ts` / `execute-pitch` identical to `main`. |
| 2026-09-16 landed | #32 then #34 on `main` (`c95b3a7` → `2febf56`). Collide files resolved as specified. #33 merged separately after (`ac521fa`) — out of this lane. **Git traffic done.** |

### #34 review — greenlight at `eed709c`

| Box | Result |
|-----|--------|
| Submit via Hub on `submit_sync_outreach` | **Pass.** Pending drafts, Approve/Reject, Dry-run, **Submit via Hub**. No `execute_sync_pitch`. No new edge. |
| `licensing_pitch_log` + `resend_message_id` | **Pass.** Insert after provider accept. `dispatched_via=submit_sync_outreach`. |
| Playlist From / `resend-pitch.ts` / `execute-pitch` | **Pass.** Diff vs `main` is empty for those files. |
| Gmail From rejected | **Pass.** `providerFromHeader` drops `@gmail.com` / `@googlemail.com` to `pitches@`. Env-only; no caller From. |
| Optional `SYNC_FROM_EMAIL` | **Pass.** `useSyncFrom` only on sync submit. Split-sheet / default transport stay on `FROM_EMAIL`. Playlist helpers ignore it. |

`eed709c` also carries flipped gap tests (closes the earlier rebase condition).

**Merge collide (expected, small):** #32 and #34 both add `.env.example` comments and `sync-playlist-outbound-gap.test.ts`. Resolve by **keeping #34** (closed-gap assertions + wired `SYNC_FROM_EMAIL` comment). Keep #32's `docs/SYNC_VS_PLAYLIST_OUTBOUND_GAP.md`.

**Residual (do not block):** log insert failure after live send still returns 200 with `licensing_pitch_log: null`. First **Submit via Hub** in prod is a real Resend send — Dry-run first.

**Redeploy after #34:** Lovable SQL Editor paste `20260916000000_licensing_pitch_log_hub_send.sql`; set optional `SYNC_FROM_EMAIL` only if the mailbox exists; redeploy `control-center-api` + publish frontend. Do **not** redeploy `execute-pitch`.
