# Claude handoff — Pitch pipeline fixes + Fan IG engagement

**Date:** 2026-06-02  
**Operator:** Fendi (session-budget-conserving; code via Cursor/GitHub, deploy via Lovable)  
**Repo:** https://github.com/fendifrost-dot/fan-growth-pilot  
**Local path:** `/Users/gocrazyglobal/artistgrowthhub-repo`  
**Supabase project:** `vsemrziqxrrfcquxfnwd`  
**Edge function base:** `https://vsemrziqxrrfcquxfnwd.supabase.co/functions/v1/`  
**Production admin:** `app.bemoremodest.com/admin/*`  
**Lovable:** FanFuel Hub → Cloud → SQL Editor / Secrets / Publish  

**Parent docs:** `CLAUDE_HANDOFF.md`, `docs/GROWTH_WORKFLOW.md`, `docs/PLAYLIST_PITCH_FAST_PATH.md`, `docs/HANDOFF_CLAUDE_OUTREACH_DEPLOY.md`

---

## 0. Rules (carry forward)

1. **Lovable chat = deploy/redeploy ONLY.** Never accept code suggestions from Lovable AI chat.
2. **All code changes via GitHub push** to `fendifrost-dot/fan-growth-pilot` (Cursor). No Lovable file edits.
3. **Schema via Lovable SQL Editor** — **paste, don't type** (Monaco strips leading `U` from `UPDATE`).
4. **GitHub push ≠ live.** After push: Lovable **Publish** (frontend) + redeploy touched edge functions.
5. Admin UI calls **`control-center-api`** via session JWT (`callHubFn`), not browser hub key — see `docs/HANDOFF_ADMIN_JWT_AUTH.md`.
6. **Do not commit** `.env`, hub keys, or personal CSVs.

---

## 1. Executive summary

Two major bodies of work landed on `main` between 2026-06-01 and 2026-06-02:

| Track | Status on `main` | Production deploy |
|-------|------------------|-------------------|
| **A. Pitch pipeline fixes** (4 fixes + polish) | ✅ Committed & verified | ✅ Migrated + redeployed (Fendi) |
| **B. Fan Instagram engagement** | ✅ Committed (`3d67196`) | ⏳ Needs migration + Publish + CCA redeploy |

---

## 2. Track A — Pitch pipeline fixes

### 2.1 Commits (in order)

| Commit | Summary |
|--------|---------|
| `cb83237` | `execute-pitch`: capture `resend_message_id` from Resend API `{ id }` |
| `c9429a7` | `patch_target`: 404 on missing playlist + whitelist expansion |
| `f0a6e83` | `log_platform_pitch` + platform columns on `pitch_log` |
| `fc7110a` | `contact-extract`: Spotify vendor domain denylist |
| `3e5844c` | Polish: `last_pitched_at` on email send, platform/track validation, `tier_confirmed` on approve, `last_pitched_at` patch field |

**Note:** `patch_target` and `log_platform_pitch` live in `supabase/functions/_shared/playlist-agent-run.ts`, routed through `control-center-api` via `isPlaylistAgentAction()` — not in `control-center-api/index.ts` directly.

### 2.2 Schema (already applied in prod)

```sql
ALTER TABLE pitch_log ADD COLUMN IF NOT EXISTS resend_message_id text;
ALTER TABLE pitch_log ADD COLUMN IF NOT EXISTS platform_name text;
ALTER TABLE pitch_log ADD COLUMN IF NOT EXISTS platform_pitch_id text;
ALTER TABLE pitch_log ADD COLUMN IF NOT EXISTS platform_pitch_url text;
ALTER TABLE pitch_log ADD COLUMN IF NOT EXISTS platform_cost_usd numeric DEFAULT 0;
```

Doc-only copy: `supabase/migrations/20260601_pitch_log_platform_tracking.sql`

### 2.3 Fix details

#### Fix 1 — `resend_message_id`

- **File:** `supabase/functions/execute-pitch/index.ts`
- Parses Resend success JSON, stores `id` on `pitch_log` insert.
- **Verified:** QA send to `fendifrost@gmail.com` stored non-null ID (UUID format, not always `re_` prefix — still valid for Resend dashboard lookup).

#### Fix 2 — `patch_target` validation + whitelist

- **404** if `playlist_id` not in `playlist_targets`: `{ "error": "playlist_not_found", "playlist_id": "..." }`
- **New patchable fields:** `pitch_status`, `contact_confidence` (1–10), `is_active`, `submission_method`
- **Also added (polish):** `last_pitched_at` (ISO or `null` to clear)
- **Behavior change:** Auto `contact_confidence: 9` only when going from **no email → email** (reverts don't re-bump)

#### Fix 3 — `log_platform_pitch`

- **Action:** `log_platform_pitch` via `control-center-api`
- Inserts `pitch_log` with `method = platform_name`, `status = sent`, platform columns populated, `resend_message_id = null`
- Updates `playlist_targets`: `pitch_status = pitched`, `last_pitched_at = now()`
- **Requires:** `track_name` on body or non-empty on `playlist_targets`
- **`platform_name` whitelist:** `groover`, `submithub`, `soundplate`, `one_submit`, `submitlink`, `dailyplaylists`, `indiemono`

**Groover example:**

```bash
export CCA="https://vsemrziqxrrfcquxfnwd.supabase.co/functions/v1/control-center-api"
curl -sS -X POST "$CCA" -H "content-type: application/json" -d '{
  "action": "log_platform_pitch",
  "playlist_id": "spotify:PLAYLIST_ID",
  "platform_name": "groover",
  "track_name": "Designed For Me (Control)",
  "platform_pitch_url": "https://groover.co/...",
  "platform_cost_usd": 3
}'
```

#### Fix 4 — EMAIL denylist

- **File:** `supabase/functions/_shared/contact-extract.ts`
- Domain **suffix** deny: `spotify.com`, `spotifyforvendors.com`, `noreply.form`
- **One-time cleanup SQL (optional):** `supabase/migrations/20260601_scrub_spotify_vendor_emails.sql`

### 2.4 Email approve polish (`3e5844c`)

- `approve_draft` + `send_immediately` now sets `playlist_targets.last_pitched_at` on successful email send
- Passes `tier_confirmed: true` to `execute-pitch` (admin approval = tier-3 confirm)
- QA tip: use `"test_mode": true` on `approve_draft` for test sends (no `pitch_log`, no cooldown)

### 2.5 Functions redeployed (pitch track)

- `execute-pitch`
- `control-center-api`
- `enrich-curator-contacts`

### 2.6 Live campaign — do not touch

**"Designed For Me (Control)" deep-house campaign** — these rows stay as-is:

- MixMason, Different Twins, musicto, Tanzgemeinschaft, Noir Frequencies, Joe Bruford / Liam Murphy (6 pitched)
- Deactivated deep_house rows (no contact) — leave off
- Rap-seed rows (`lane = NULL`) — future campaign; OK for throwaway API tests only

### 2.7 QA cleanup (completed)

Throwaway rap-seed rows used for verification were reverted:

- `pending-top-rap`, `pending-rapwrld-tohiphophub` → `pitch_status: not_pitched`, emails restored
- SQL deleted QA `pitch_log` rows and cleared `last_pitched_at`

---

## 3. Track B — Fan Instagram engagement (NEW)

### 3.1 Purpose

Engage **followers who follow Fendi on Instagram** — not playlist curators. Build owned audience (email/Telegram) without cold promo spam.

| Principle | Implementation |
|-----------|----------------|
| Engagement-first | Stage 1 openers have no links/asks |
| Runway Music | Stage 2 mentions project naturally |
| Soft list invite | Stage 3 optional email list ask |
| 10/day cap | `FAN_IG_DAILY_CAP = 10` (UTC) |
| No cron auto-send | Human sends each DM (Open & copy or API) |
| Daily stable templates | Same generic prompt per stage for all fans that UTC day |
| Per-fan personalization | OpenAI light rewrite (or `{first_name}` slots fallback) |

### 3.2 Commit

`3d67196` — `feat(fan-ig): daily template DMs with AI personalization, Open & copy, optional API send`

### 3.3 Schema (NOT yet applied — run in Lovable)

File: `supabase/migrations/20260602_fan_ig_engagement.sql`

```sql
-- instagram_fan_roster + fan_engagement_queue
-- (full DDL in migration file — paste entire file in SQL Editor)
```

Tables:

| Table | Purpose |
|-------|---------|
| `instagram_fan_roster` | Fan handles, `follows_me`, `i_follow`, `dm_stage`, optional `ig_user_id`, `do_not_contact` |
| `fan_engagement_queue` | Pending/sent DMs with template slug, draft text, operator brief, personalization method |

### 3.4 Template library

**File:** `supabase/functions/_shared/fan-dm-templates.ts`

| Stage | Count | Content |
|-------|-------|---------|
| `opener` | 10 | Thanks for following, no pitch |
| `runway` | 10 | Runway Music / latest post mention |
| `invite` | 5 | Soft email list invite |

- **`pickDailyTemplate(stage)`** — UTC date hash → same template index for everyone that day
- Slots: `{first_name}`, `{handle}`, `{display_name}`

### 3.5 AI personalization

**File:** `supabase/functions/_shared/fan-dm-personalize.ts`

- Uses `OPENAI_API_KEY` + model `OPENAI_FAN_DM_MODEL` (default `gpt-4o-mini`)
- Keeps template intent; max ~4 sentences; no hard sell
- Falls back to slot substitution if no key or API error
- Method logged as `personalization_method`: `openai` | `slots`

### 3.6 Backend actions (control-center-api)

**File:** `supabase/functions/_shared/fan-engagement-run.ts`  
Wired in `control-center-api/index.ts` via `isFanEngagementAction()`.

| Action | Purpose |
|--------|---------|
| `import_fan_roster` | Bulk paste handles |
| `list_fan_roster` | List fans |
| `patch_fan_roster` | Update flags, `ig_user_id`, `dm_stage`, DNC |
| `queue_fan_dm_batch` | Queue up to 10 fans (follows_me, not DNC, oldest contact first) |
| `list_fan_dm_queue` | Pending rows + daily quota |
| `update_fan_dm_draft` | Save edited message before send |
| `mark_fan_dm_sent` | Mark sent; advance roster `dm_stage` (opener→runway→invite) |
| `get_instagram_messaging_status` | Proxy to `instagram-messaging?action=status` |
| `send_fan_dm_via_api` | POST to Graph API (needs valid token + `ig_user_id`) |

### 3.7 Admin UI

| Path | File |
|------|------|
| `/admin/fan-ig-queue` | `src/pages/admin/AdminFanIgQueue.tsx` |
| Nav link | `AdminGuard.tsx` → **Fan IG** |
| Send center card | `AdminSendCenter.tsx` → Fan IG queue link |

**Daily operator flow:**

1. Paste fan handles → **Import roster**
2. **Queue today's batch (10 max)**
3. Per row: review/edit message → **Open & copy** (clipboard + `ig.me/m/{handle}`) → paste in IG → send → **Mark sent**
4. Optional: **Send via API** when token valid and `ig_user_id` set on roster row

### 3.8 Instagram API token status (checked 2026-06-02)

```
GET .../instagram-messaging?action=status
→ Token EXPIRED 2026-04-28 (OAuthException code 190)
```

- Secret name: `INSTAGRAM_MESSAGING_API_TOKEN`
- **Open & copy works without token**
- **Send via API** blocked until token refreshed in Lovable Cloud → Secrets
- Regenerate long-lived Meta Page token with `instagram_manage_messages`

### 3.9 Curator IG vs Fan IG (don't confuse)

| | Curator IG | Fan IG |
|---|------------|--------|
| Admin | `/admin/ig-queue` | `/admin/fan-ig-queue` |
| Roster | `instagram_curator_roster` (mutual required) | `instagram_fan_roster` (`follows_me`) |
| Queue table | `social_engagement_queue` | `fan_engagement_queue` |
| Batch action | `queue_ig_outreach_batch` | `queue_fan_dm_batch` |
| Audience | Playlist curators | Your followers |

---

## 4. Deploy checklist for Claude

### Already done (pitch track)

- [x] Pitch schema migration
- [x] Redeploy `execute-pitch`, `control-center-api`, `enrich-curator-contacts`
- [x] Verification 6.1–6.3 passed
- [x] QA throwaway rows reverted

### Remaining (fan IG track)

1. **SQL Editor** — paste full `supabase/migrations/20260602_fan_ig_engagement.sql`
2. **Lovable Publish** — frontend (for `/admin/fan-ig-queue` route in `App.tsx`)
3. **Redeploy** `control-center-api` (fan actions in shared module)
4. **Optional:** Redeploy `instagram-messaging` if that function was stale
5. **Secrets check:**
   - `OPENAI_API_KEY` — for AI personalization
   - `INSTAGRAM_MESSAGING_API_TOKEN` — refresh if API send desired
6. **Smoke test:**

```bash
export CCA="https://vsemrziqxrrfcquxfnwd.supabase.co/functions/v1/control-center-api"

# Token status
curl -sS -X POST "$CCA" -H "content-type: application/json" \
  -d '{"action":"get_instagram_messaging_status"}'

# Import one test fan (use a real handle you control)
curl -sS -X POST "$CCA" -H "content-type: application/json" \
  -d '{"action":"import_fan_roster","entries":[{"ig_handle":"YOUR_HANDLE","display_name":"Test","follows_me":true}]}'

# Queue batch
curl -sS -X POST "$CCA" -H "content-type: application/json" \
  -d '{"action":"queue_fan_dm_batch","limit":1}'

# List queue
curl -sS -X POST "$CCA" -H "content-type: application/json" \
  -d '{"action":"list_fan_dm_queue","status":"pending","limit":5}'
```

7. **UI:** Open `app.bemoremodest.com/admin/fan-ig-queue` → confirm token banner, import, queue, Open & copy

---

## 5. File map

```
supabase/functions/
  execute-pitch/index.ts              # resend_message_id capture
  control-center-api/index.ts         # fan engagement + playlist agent routing
  instagram-messaging/index.ts        # Graph API send/read (token expired)
  _shared/
    playlist-agent-run.ts             # patch_target, log_platform_pitch
    contact-extract.ts                # Spotify denylist
    fan-dm-templates.ts               # 25 daily-rotating templates
    fan-dm-personalize.ts             # OpenAI personalization
    fan-engagement-run.ts             # fan IG actions
    ig-outreach.ts                    # curator IG (existing)
    outreach-templates.ts             # curator briefs (existing)

supabase/migrations/
  20260601_pitch_log_platform_tracking.sql
  20260601_scrub_spotify_vendor_emails.sql
  20260602_fan_ig_engagement.sql

src/pages/admin/
  AdminFanIgQueue.tsx                 # NEW fan DM UI
  AdminSocialQueue.tsx                # curator DM UI (existing)

docs/
  PLAYLIST_PITCH_FAST_PATH.md         # curl examples incl. log_platform_pitch, test_mode
  GROWTH_WORKFLOW.md                  # curator IG workflow (add fan IG section if missing)
  HANDOFF_CLAUDE_JUN2026.md           # this file
```

---

## 6. Known gaps / out of scope

| Item | Notes |
|------|--------|
| Auto IG follower Graph sync | Not built — import handles manually (paste) |
| Scheduled/cron DM sends | Intentionally omitted (ban risk) |
| Auto-paste into IG compose from web | Not possible without browser extension; **Open & copy** is v1 |
| Pre-fix pitch sends missing `resend_message_id` | Different Twins, MixMason from 2026-06-01 — no backfill |
| `ig_user_id` on fan roster | Required for API send; manual patch or future Graph lookup |
| `GROWTH_WORKFLOW.md` fan section | May need update to mirror §3.7 operator flow |

---

## 7. Copy-paste prompt for Claude

```
You are continuing work on fan-growth-pilot (fendifrost-dot/fan-growth-pilot).

READ FIRST: docs/HANDOFF_CLAUDE_JUN2026.md

CONTEXT:
- Pitch pipeline fixes (resend_message_id, patch_target, log_platform_pitch, denylist) are on main, migrated, deployed, verified.
- Fan IG engagement module is on main (3d67196) but needs migration 20260602_fan_ig_engagement.sql + Lovable Publish + control-center-api redeploy.
- INSTAGRAM_MESSAGING_API_TOKEN is EXPIRED (2026-04-28). Open & copy works; refresh token for API send.
- OPENAI_API_KEY enables per-fan DM personalization; without it, {first_name} slot fill only.

YOUR TASKS (in order):
1. Confirm git log includes 3d67196 and fan IG files exist.
2. Remind Fendi to run 20260602 migration in Lovable SQL Editor (paste, don't type UPDATE).
3. Lovable Publish + redeploy control-center-api (deploy only in Lovable chat — no code edits).
4. Smoke test get_instagram_messaging_status, import_fan_roster, queue_fan_dm_batch, list_fan_dm_queue.
5. Optional: refresh INSTAGRAM_MESSAGING_API_TOKEN; run scrub_spotify_vendor_emails.sql if ap@spotify.com rows remain.
6. Do NOT touch live deep-house pitched rows or deactivated deep_house targets.

RULES: No Lovable code edits. No commits unless Fendi asks. Paste SQL don't type UPDATE.
```

---

## 8. Quick reference

| Item | Value |
|------|--------|
| Repo | `fendifrost-dot/fan-growth-pilot` |
| Latest fan IG commit | `3d67196` |
| Fan admin UI | `/admin/fan-ig-queue` |
| Curator admin UI | `/admin/ig-queue` |
| Daily caps | 10 IG DMs/day each (curator + fan, separate counters) |
| Platform pitch action | `log_platform_pitch` |
| QA test mode | `approve_draft` + `"test_mode": true` |

End of handoff.
