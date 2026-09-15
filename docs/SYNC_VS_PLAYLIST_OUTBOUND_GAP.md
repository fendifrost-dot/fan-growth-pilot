# Sync vs playlist outbound — gap report

**Repo:** `fendifrost-dot/fan-growth-pilot`  
**Date:** 2026-09-15  
**Scope:** map how playlist pitches leave the Hub vs how sync/licensing pitches leave (or fail to).  
**Hard rules for this work:** no live email, no invented secrets, no Lovable chat.

This is a **map + plan**, not a claim that production already sends sync via Resend.
Recent sync mail from `fendifrost@gmail.com` is evidence the **professional Hub path was not the one used**, not evidence that Resend cannot send sync.

---

## Verdict (read this first)

| Claim | Verdict |
|---|---|
| Playlist already sends professionally via Resend on `fendifrost.com` | **Confirmed.** Dedicated edges `execute-pitch` / `send-pitch-email` + CCA `approve_draft`. |
| Sync has **no** Resend wrapper at all | **Discarded.** CCA action `submit_sync_outreach` already calls `sendProviderEmail` → `https://api.resend.com/emails`. |
| Sync lacks a dedicated `execute-sync-pitch` edge | **True, and not the blocker.** Playlist has a dedicated edge; sync folds send into CCA. Either shape can work. |
| `licensing_pitch_log` is the sync send ledger | **Discarded.** That table is **record-only**. Admin `/admin/licensing` never calls Resend. |
| `BLOCKED_NO_SYNC_MCP` still means no Hub write path | **Stale.** Claude now has `mcp-sync-discovery` for research/draft. **Send remains Grok/Fendi-only by design.** |
| Gmail From means Hub Resend was used | **Discarded.** Hub From default is `pitches@fendifrost.com`. A Gmail From is a **side-channel compose**. |

**Working theory of the recent Gmail sends:** agents (or a human) composed from personal Gmail because the Hub send door is real in code but **not exposed** on Claude MCP, **not exposed** on `/admin/licensing`, and only reachable as Grok (`GROK_PLAYLIST_CONTROL_SECRET`) or Fendi (exact `ARTIST_USER_ID` JWT) calling `control-center-api` `submit_sync_outreach`. That is an **operator-surface gap**, not a missing Resend client.

---

## 1. Playlist send chain (current)

```
Operator / Grok
  └─ Admin UI (AdminSendCenter / AdminOutreachDrafts / AdminPitchComposer)
       or CCA action approve_draft (send_immediately)
         └─ playlist-agent-run.ts
              └─ POST /functions/v1/execute-pitch   (x-api-key: FANFUEL_HUB_KEY)
                   ├─ require approved outreach_drafts.draft_id
                   ├─ verifyApprovedContentHash + verifyDraftPitchIntegrity
                   ├─ evaluateOutreachDecision / checkSendEligibility
                   ├─ send window + per-song / global caps
                   ├─ POST https://api.resend.com/emails
                   │    From:    Fendi Frost <FROM_EMAIL || pitches@fendifrost.com>
                   │    Reply-To: REPLY_TO_EMAIL || replies@fendifrost.com
                   └─ INSERT pitch_log
                        status=sent, resend_message_id, subject, email_body,
                        dispatched_via=execute-pitch, approved_by / approved_at
```

Secondary playlist dispatcher (same Resend helper, same From/Reply-To):

```
send-pitch-email  (FANFUEL_HUB_KEY)
  └─ sendResendEmail() in _shared/resend-pitch.ts
       └─ INSERT pitch_log  dispatched_via=send-pitch-email
```

Radio is a sibling of `send-pitch-email` (`kind=radio`) and writes `radio_pitch_log`, not `pitch_log`. Fan campaigns (`send-campaign-email`) use **per-campaign** `from_name` / `from_email` and are out of scope.

### Playlist files

| Piece | File |
|---|---|
| Dedicated send edge | `supabase/functions/execute-pitch/index.ts` |
| Alternate send edge | `supabase/functions/send-pitch-email/index.ts` |
| Shared From / Reply-To / payload | `supabase/functions/_shared/resend-pitch.ts` |
| Approve → proxy execute-pitch | `supabase/functions/_shared/playlist-agent-run.ts` |
| CCA router | `supabase/functions/control-center-api/index.ts` |
| Admin send buttons | `src/pages/admin/AdminSendCenter.tsx`, `AdminOutreachDrafts.tsx`, `AdminPitchComposer.tsx` |
| Browser → CCA | `src/lib/hubApi.ts` (`Authorization: Bearer` session JWT) |
| Ledger | `pitch_log` (`resend_message_id`, `subject`, `email_body`, `dispatched_via`, `draft_id`) |
| Bounce handling | `supabase/functions/resend-webhook/index.ts` → `playlist_targets` + `domain_blocklist` only |

### Playlist secrets (names only — do not invent values)

Set in **Lovable Cloud → Secrets**, not in the repo:

| Secret | Role |
|---|---|
| `RESEND_API_KEY` | Required to call Resend. Missing → execute-pitch returns an error and does not apply cooldown. |
| `FROM_EMAIL` | Optional. Code default `pitches@fendifrost.com`. |
| `REPLY_TO_EMAIL` | Optional. Code default `replies@fendifrost.com`. `.env.example` still comments `fendifrost@gmail.com`. |
| `FANFUEL_HUB_KEY` | Server-to-server gate on `execute-pitch` / `send-pitch-email` / CCA hub-key path. |
| `SUPABASE_SERVICE_ROLE_KEY` | Injected by Lovable into Edge at runtime (not something agents operate). |
| `RESEND_WEBHOOK_SECRET` | Optional query/header check on `resend-webhook`. |

Domain: `fendifrost.com` is the verified Resend sending domain (DKIM `resend._domainkey`, Return-Path `send.fendifrost.com`). See `docs/FENDIFROST_RESEND_DNS_DELIVERABILITY.md`.

### Playlist Reply-To vs Gmail

Principal intent (this ticket): **From looks like business mail; replies still land in Gmail.**

That is already the playlist model **if** production `REPLY_TO_EMAIL` is Gmail **or** `replies@fendifrost.com` is forwarded to Gmail. Code default is `replies@`; older docs / `.env.example` still say Gmail. **Do not put Gmail in `From`.** Align the secret + Cloudflare Email Routing; leave the From on `@fendifrost.com`.

---

## 2. Sync / licensing send chain (current)

There are **three** sync-adjacent paths. Only one can call Resend.

### 2a. Hub Resend path — exists, narrowly authorized

```
Grok (x-grok-playlist-control-secret)  or  Fendi (ARTIST_USER_ID JWT)
  └─ CCA action submit_sync_outreach
       └─ sync-control.ts → submitSyncOutreach()
            ├─ capability submit_sync_outreach
            ├─ actor must be grok_playlist_control or fendi
            ├─ approved sync_research_pitch_drafts row (no caller subject/body)
            ├─ verified target email + computeTrackSyncEligibility
            ├─ sendProviderEmail()
            │    POST https://api.resend.com/emails
            │    From:    Fendi Frost <FROM_EMAIL || pitches@fendifrost.com>
            │    Reply-To: REPLY_TO_EMAIL || replies@fendifrost.com
            │    Idempotency-Key: draft.send_idempotency_key
            └─ UPDATE sync_research_pitch_drafts
                 status=submitted, submission_message_id=Resend id
               UPDATE sync_research_opportunities.status=submitted
               (does NOT insert licensing_pitch_log)
               (does NOT insert pitch_log)
```

Test mode: `AGH_PROVIDER_TEST_MODE=1` or `AGH_TEST_MODE=1` short-circuits Resend and returns `test_…` ids. If that flag is left on in production, Hub will **claim submitted without sending**.

`web_form` does **not** send: status becomes `awaiting_manual_submission` until `record_manual_sync_outreach_submission`. That packet is the designed manual door — Gmail compose is **not** a documented transport.

Sibling: split-sheet delivery (`split-sheet-delivery.ts`) also uses `sendProviderEmail` (same From/Reply-To). Out of scope except it shares reputation with playlist if `FROM_EMAIL` is shared.

### 2b. Licensing register — log only, no send

```
/admin/licensing  (AdminLicensing.tsx)
  └─ callHubFn("log_licensing_pitch")
       └─ sync-registers.ts
            └─ INSERT licensing_pitch_log
                 status='sent'   ← bookkeeping flag, not a provider receipt
                 (no resend_message_id, subject, body, draft_id, dispatched_via)
```

File comment is explicit: *“No send path — recording only.”*

This is the table people treat as “sync pitch_log.” It is **not** the playlist analogue. `log_licensing_pitch` will happily mark a row `sent` after a Gmail compose. That is how a professional-looking register can hide an unprofessional From.

### 2c. Claude sync MCP — research/draft only

`mcp-sync-discovery` tools:

`get_sync_discovery_work`, `submit_sync_targets`, `submit_sync_opportunities`, `create_sync_drafts`, `verify_sync_contacts`, `advance_sync_batch`, station start/complete, `get_own_sync_batches`.

**Not present (intentional):** `approve_sync_outreach`, `submit_sync_outreach`, playlist send tools, Song DNA / eligibility approval.

Historical name `BLOCKED_NO_SYNC_MCP` referred to Claude having **no authenticated sync write surface**. That is fixed for **research/draft**. It was never a send MCP, and it still is not.

There is **no Grok MCP** for sync submit. Grok’s playlist send is CCA `approve_draft` → `execute-pitch`. Grok’s sync send is CCA `submit_sync_outreach` only.

### Sync files

| Piece | File | Sends? |
|---|---|---|
| Submit / approve / reject | `supabase/functions/_shared/sync-control.ts` | Email via Resend |
| Provider transport | `supabase/functions/_shared/provider-transport.ts` | Yes |
| Research / draft | `supabase/functions/_shared/sync-research.ts` | No |
| Claude MCP | `supabase/functions/mcp-sync-discovery/index.ts` + `_shared/sync-discovery-mcp.ts` | No |
| Supervisor + licensing log | `supabase/functions/_shared/sync-registers.ts` | **No** |
| Admin licensing UI | `src/pages/admin/AdminLicensing.tsx` | **No** |
| Auth matrix | `supabase/functions/_shared/ops-actors.ts`, `outreach-auth.ts` | — |
| CCA router | `control-center-api/index.ts` (`isSyncControlAction` / `isSyncRegisterAction`) | Routes both |

There is **no** `supabase/functions/execute-sync-pitch/` directory.

### Sync secrets (names only)

Same Resend pair as playlist (`RESEND_API_KEY`, `FROM_EMAIL`, `REPLY_TO_EMAIL`), plus:

| Secret | Role |
|---|---|
| `GROK_PLAYLIST_CONTROL_SECRET` | Identifies Grok; required for agent submit. |
| `CLAUDE_SYNC_DISCOVERY_SECRET` | Optional narrow Claude research secret (OAuth preferred). |
| `AGH_PROVIDER_TEST_MODE` / `AGH_TEST_MODE` | Must be **unset** for real sends. |
| Fendi JWT / `ARTIST_USER_ID` | Human principal submit via Admin session (if a UI called the action). |

Human admin JWT **cannot** `approve_sync_outreach` or `submit_sync_outreach` (`HUMAN_ADMIN_CAPS` omits both). Claude cannot. Only Grok + Fendi.

### Sync ledgers compared to `pitch_log`

| Field / behavior | `pitch_log` (playlist) | `sync_research_pitch_drafts` | `licensing_pitch_log` |
|---|---|---|---|
| Provider message id | `resend_message_id` | `submission_message_id` | **missing** |
| Subject / body stored | yes | yes (the draft) | **missing** |
| `dispatched_via` | yes | no | **missing** |
| Written by Resend accept | yes | yes (`submit_sync_outreach`) | **no** |
| Written by Admin “record” | no | no | **yes**, status=`sent` |
| Bounce webhook | `playlist_targets` | **none** | **none** |
| Generated `types.ts` | complete | **stale** (omits submit/response columns) | matches slim schema |

---

## 3. Why Gmail happened (and why the dedicated-edge hunch was wrong)

1. **No operator Send button for sync.** Playlist has `/admin` approve-and-send. Sync admin is “Record a licensing pitch.”
2. **Claude cannot submit.** Discovery MCP stops at drafts + handoff batches.
3. **Grok submit is CCA-only** and needs the Grok playlist-control secret. Cursor agents without that credential have no Hub door.
4. **`web_form` / manual packet** invites an external send. Gmail is the easiest external send.
5. **`log_licensing_pitch` rewards the side channel** by storing `status=sent` with no provider id.
6. A dedicated `execute-sync-pitch` edge would **not** have prevented (1)–(5) by itself. Playlist works because **UI + Grok CCA + dedicated edge + `pitch_log`** are wired together.

If someone *had* used `submit_sync_outreach` with production Resend and no test-mode flag, From would already have been `Fendi Frost <pitches@fendifrost.com>` — same class as playlist. Gmail From falsifies that path.

---

## 4. From-address recommendation

Goal: supervisors see the same **class** of business identity as curators, not a personal Gmail mailbox.

| Header | Recommendation | Why |
|---|---|---|
| **From (short-term)** | Keep `Fendi Frost <pitches@fendifrost.com>` via existing `FROM_EMAIL` | Already coded; domain warmed; no new Resend identity required. |
| **From (preferred)** | `Fendi Frost <sync@fendifrost.com>` via new optional `SYNC_FROM_EMAIL` | Separates supervisor mail from curator mail so a sync complaint does not torch playlist reputation. Same organizational domain. |
| **Display name** | `Fendi Frost` (match playlist) or `Fendi Frost — Licensing` | Recognizable artist, not a raw local-part. |
| **Reply-To** | Keep `REPLY_TO_EMAIL` → Gmail inbox (`fendifrost@gmail.com`) **or** `replies@fendifrost.com` forwarded there | Replies stay in the principal’s real inbox without using Gmail as From. |
| **Do not use** | `From: fendifrost@gmail.com` | Fails the professional bar; fails DMARC alignment with the Resend domain. |

`sync@` / `replies@` are **recommendations**, not confirmed live mailboxes. Adding a new local-part on an already-verified `fendifrost.com` Resend domain does not require a new domain verify. It **does** require creating the identity in Resend and (if you want the mailbox to receive) Cloudflare Email Routing → Gmail.

Do **not** recommend `pitches@` as Reply-To unless that mailbox is actually read.

---

## 5. Exact files / APIs to add or fix

Do **not** invent a second sync pipeline. Extend the existing CCA + provider transport.

### Phase 1 — make the existing Resend path the only email door (no live send in this PR)

| Change | Where |
|---|---|
| Admin: list pending sync drafts, approve/reject, **Submit via Hub** | New or extend `src/pages/admin/AdminLicensing.tsx` (or `AdminSyncOutreach.tsx`) calling `list_sync_pending_drafts`, `approve_sync_outreach`, `submit_sync_outreach` via `callHubFn` |
| Agent playbook: Grok submits via CCA; **never** Gmail From | This doc + Daily Ops copy |
| Confirm Lovable secrets exist (names only) | `RESEND_API_KEY`, `FROM_EMAIL`, `REPLY_TO_EMAIL`, `GROK_PLAYLIST_CONTROL_SECRET`; `AGH_PROVIDER_TEST_MODE` **unset** in prod |
| Redeploy | Lovable → Edge Functions: `control-center-api` (and `mcp-sync-discovery` if not live) |
| Config drift | `supabase/config.toml` lists `execute-pitch` / `mcp-playlist-discovery` but **not** `mcp-sync-discovery` or `control-center-api` |

### Phase 2 — From identity (still no new edge required)

| Change | Where |
|---|---|
| Optional `SYNC_FROM_EMAIL` (default `sync@fendifrost.com` once the mailbox exists; else fall back to `FROM_EMAIL`) | `provider-transport.ts`; pass from `submitSyncOutreach` only (leave playlist `resend-pitch.ts` alone) |
| Document Reply-To vs From | `.env.example`, this doc, `FENDIFROST_RESEND_DNS_DELIVERABILITY.md` |
| Create `sync@` (and/or confirm `replies@` routing) | Resend dashboard + Cloudflare Email Routing — **ops, not code** |

A new `execute-sync-pitch` edge is **optional playlist-shaped sugar**. Only add it if a caller cannot reach CCA. Prefer one send implementation (`sendProviderEmail`).

### Phase 3 — ledger parity with `pitch_log`

| Change | Where |
|---|---|
| Migration: add `resend_message_id`, `subject`, `email_body`, `draft_id`, `dispatched_via`, `song_dna_version_id` to `licensing_pitch_log` | `supabase/migrations/` (apply via Lovable SQL Editor) |
| After provider accept, insert/upsert `licensing_pitch_log` | `submitSyncOutreach` in `sync-control.ts` |
| `log_licensing_pitch` for **true external** mail only; do not default `status=sent` without `submission_evidence` | `sync-registers.ts` + Admin form copy |
| Refresh generated types | `src/integrations/supabase/types.ts` (draft submit columns are already missing) |
| Bounce / complaint | `resend-webhook/index.ts` should also match `submission_message_id` / licensing `resend_message_id` |

### Phase 4 — optional ergonomics

- Grok MCP tools for review/approve/submit (mirrors Claude discovery MCP; not required if Grok already has CCA).
- Sync send-window / daily cap (playlist has both; sync volume is low).
- Idempotency already exists on drafts (`send_idempotency_key`).

---

## 6. Acceptance tests (implementation PR — do not send live mail)

### Automated (this repo)

Already on `main` (keep green):

- `sync-operating-stack.test.ts` — test-mode submit marks `submitted` + `test_` id; caller subject/body rejected; provider failure → `send_failed`; `web_form` → `awaiting_manual_submission`.
- `sync-split-delivery-corrections.test.ts` — `sendProviderEmail` test-mode / failure sanitization.
- `outreach-cutover-acceptance.test.ts` — playlist draft-bound send.

Added in this branch:

- `sync-playlist-outbound-gap.test.ts` — wiring contract for the map above (no network).

### Manual / live (later implementation; test mode only)

1. `AGH_PROVIDER_TEST_MODE=1`. Grok `submit_sync_outreach` on an approved fixture draft → `submitted=true`, `provider_message_id` starts with `test_`. **No Resend dashboard row.**
2. Same call with caller `subject`/`body` → `400 caller_copy_override_rejected`.
3. Claude MCP `tools/list` still has no `submit_sync_outreach`.
4. `/admin/licensing` “Record” does not call Resend (network tab / function logs).
5. After Phase 3: a test-mode submit writes `licensing_pitch_log.resend_message_id` (`test_…`) and `dispatched_via=submit_sync_outreach`.
6. Playlist regression: one `approve_draft` **test_mode** still uses `execute-pitch` and writes **no** `pitch_log` (existing contract).

### Live Resend (principal-only, later)

- One message to a **non-Gmail test sink** (mail-tester / friend), never the principal’s Gmail as a spam-training loop.
- From must be `@fendifrost.com`. Reply-To may be Gmail.
- Confirm Resend dashboard id matches `submission_message_id`.

---

## 7. What this PR does / does not do

**Does:** document the map, discard wrong hunches, lock wiring with Deno tests, clarify From vs Reply-To in `.env.example`.

**Does not:** send email, rotate/create secrets, open Lovable chat, redeploy edges, apply SQL, add `execute-sync-pitch`, or change production From.

---

## Pre-flight (agent bootstrap)

1. Repo: `fendifrost-dot/fan-growth-pilot`
2. Deploy: Lovable
3. Database: Lovable-managed Supabase (SQL Editor only)
4. Project ref: `vsemrziqxrrfcquxfnwd`
5. Canonical branch: `main`
6. Source of truth: `supabase/migrations/` + this repo
