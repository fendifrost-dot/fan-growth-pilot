# Handoff — Admin UI session JWT (kill `VITE_FANFUEL_HUB_KEY`)

**Repo:** https://github.com/fendifrost-dot/fan-growth-pilot  
**Supabase project ref:** `vsemrziqxrrfcquxfnwd`  
**Production app:** `app.bemoremodest.com` (admin under `/admin/*`)  
**Date:** 2026-05-26  

---

## Why this landed

Lovable has **no UI** for custom `VITE_*` build env vars (Cloud → Secrets is backend-only). The old pattern baked `VITE_FANFUEL_HUB_KEY` into the browser bundle so anyone on `/admin/*` could extract the hub key and call edge functions directly, bypassing `AdminGuard`.

**Fix:** Admin pages call **`control-center-api`** with **`Authorization: Bearer <session.access_token>`**. CCA validates the JWT and enforces an admin allowlist. Server-to-server callers (Telegram Control Center, crons) still use **`x-api-key: FANFUEL_HUB_KEY`**.

---

## Architecture (current)

```
Browser (Fendi logged in)
  AdminGuard → session + optional VITE_ARTIST_USER_ID
  hubApi.callHubFn(action, body)
    POST /functions/v1/control-center-api
    Authorization: Bearer <access_token>

control-center-api
  Auth (order):
    1. x-api-key === FANFUEL_HUB_KEY → full access (hub_key)
    2. Bearer JWT → getUser() + uid ∈ ADMIN_USER_IDS or ARTIST_USER_ID
    3. else 401
  Dispatch:
    playlist-agent-run actions (list_targets, draft_pitch, approve_draft, …)
    run_playlist_research → proxy playlist-research (x-api-key server-side)
    send_campaign → proxy send-campaign-email (x-api-key server-side)
    get_fan_stats, get_leads, … (unchanged)

Downstream edge functions
  Still x-api-key only; browser never calls them directly.
```

`[functions.control-center-api] verify_jwt = false` in `supabase/config.toml` — JWT is validated inside the handler so hub-key paths keep working.

---

## Files touched (commit on `main`)

| File | Role |
|------|------|
| `src/lib/hubApi.ts` | `callHubFn(action, body)` → CCA + session Bearer |
| `src/pages/admin/AdminPlaylistTargets.tsx` | New action names (`list_targets`, `run_playlist_research`, …) |
| `src/pages/admin/AdminOutreachDrafts.tsx` | Same |
| `src/pages/admin/AdminCampaignDetail.tsx` | `send_campaign` via `callHubFn` (no inline hub key) |
| `src/pages/admin/AdminGuard.tsx` | Reject non-`VITE_ARTIST_USER_ID` when set |
| `supabase/functions/control-center-api/index.ts` | Hybrid `authenticate()` |
| `supabase/functions/_shared/playlist-agent-run.ts` | `run_playlist_research`, `send_campaign` proxies |
| `.env.example` | `VITE_ARTIST_USER_ID`; document backend secrets |

**Acceptance:** `grep -r VITE_FANFUEL_HUB_KEY src/` and `grep -r x-api-key src/` → empty.

---

## Deploy checklist (human / Lovable)

1. **GitHub `main`** — commit pushed from Cursor session (admin JWT refactor).
2. **Lovable Publish** — frontend only; no Lovable AI for code.
3. **Supabase edge deploy** (required for auth logic):
   ```bash
   cd fan-growth-pilot
   supabase link --project-ref vsemrziqxrrfcquxfnwd
   supabase functions deploy control-center-api
   ```
4. **Lovable Cloud → Secrets** (confirm present):
   - `FANFUEL_HUB_KEY` — hub + internal proxies
   - `ARTIST_USER_ID` — Fendi user UUID (admin fallback)
   - `ADMIN_USER_IDS` — optional comma-separated override
   - `SUPABASE_ANON_KEY` or `SUPABASE_PUBLISHABLE_KEY` — CCA JWT validation
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — unchanged
5. **Lovable auto `.env`** — add **`VITE_ARTIST_USER_ID`** = same as `ARTIST_USER_ID` (public UUID; enables AdminGuard allowlist). **`VITE_FANFUEL_HUB_KEY`** is unused; safe to leave if Lovable keeps it.

---

## Smoke tests

```bash
# Hub key (Telegram CC / cron) — expect 200 + rows
curl -sS -X POST "https://vsemrziqxrrfcquxfnwd.supabase.co/functions/v1/control-center-api" \
  -H "x-api-key: $FANFUEL_HUB_KEY" -H "content-type: application/json" \
  -d '{"action":"list_targets","lane":"deep_house_groove"}'

# No auth — expect 401
curl -sS -X POST "https://vsemrziqxrrfcquxfnwd.supabase.co/functions/v1/control-center-api" \
  -H "content-type: application/json" -d '{"action":"list_targets"}'

# Bad JWT — expect 401 JWT invalid
curl -sS -X POST "https://vsemrziqxrrfcquxfnwd.supabase.co/functions/v1/control-center-api" \
  -H "Authorization: Bearer not.a.real.jwt" -H "content-type: application/json" \
  -d '{"action":"list_targets"}'
```

**Browser:** Log in as Fendi → `/admin/playlists` → Network tab: CCA requests use **`Authorization: Bearer`**, not **`x-api-key`**.

---

## Not in scope / follow-ups

- **P5:** Delete redundant standalone functions (`playlist-admin-api`, etc.) after ~1 week stable.
- **Multi-admin RBAC:** `profiles.is_admin` instead of `VITE_ARTIST_USER_ID` / `ARTIST_USER_ID`.
- **Control Center repo** (`fendi-control-center`) is a **different** Supabase project; do not confuse with `vsemrziqxrrfcquxfnwd`.

---

## Workflow rules (unchanged)

- Code → **GitHub `main`** via Cursor/IDE; **Lovable Publish** for app shell.
- Edge functions → **`supabase functions deploy`** or Lovable Cloud deploy for functions — **Publish alone does not update CCA**.
- Secrets only in Lovable Cloud / Supabase dashboard — never commit `.env`.

---

## Prompt for Claude (copy-paste)

You are continuing work on **fan-growth-pilot** (`fendifrost-dot/fan-growth-pilot`), Supabase **`vsemrziqxrrfcquxfnwd`**, Lovable-hosted FanFuel / Modest admin at `app.bemoremodest.com`.

**Done (2026-05-26):** Admin UI no longer uses `VITE_FANFUEL_HUB_KEY`. All admin calls go through **`control-center-api`** with the Supabase session JWT. CCA supports hybrid auth (`x-api-key` for server, JWT + `ARTIST_USER_ID`/`ADMIN_USER_IDS` for browser). Proxies: `run_playlist_research`, `send_campaign`.

**Your job if something is broken:** (1) Confirm `control-center-api` is deployed. (2) Confirm `SUPABASE_ANON_KEY`/`SUPABASE_PUBLISHABLE_KEY` and `ARTIST_USER_ID` in edge secrets. (3) Confirm `VITE_ARTIST_USER_ID` in Lovable `.env` matches. (4) Read `docs/HANDOFF_ADMIN_JWT_AUTH.md` and grep `src/` for any regression to hub keys.

Do not reintroduce `VITE_FANFUEL_HUB_KEY` or browser `x-api-key`. Do not use Lovable AI chat for code changes.
