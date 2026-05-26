# Deploying Supabase (Lovable + GitHub)

**Project ref:** `vsemrziqxrrfcquxfnwd`

## What syncs automatically (edit in GitHub → Lovable)

- `supabase/functions/*/index.ts` — including new `refresh-platform-stats`
- `supabase/config.toml` — `verify_jwt` flags
- `src/` frontend, types, package.json

Push to GitHub; Lovable picks up edge function changes.

## What does NOT sync from GitHub (apply in Lovable)

- Database schema, RLS, triggers, row data
- **`supabase/migrations/*.sql`** and **`supabase/lovable-migrations/*.sql`** are version control + copy-paste sources only

Apply DB changes via **Lovable migration tool**. See [`lovable-migrations/README.md`](./lovable-migrations/README.md).

## Deploy order (stats fix bundle)

### 1. Edge functions (GitHub → auto-sync)

Changed or new:

- `control-center-api`
- `fetch-public-spotify-data`
- `scrape-chartmetric`
- `fan-intelligence`
- `refresh-platform-stats` (new)
- `project-stats` (clarified response)

### 2. Secrets (Lovable / Supabase dashboard)

| Secret | Required for |
|--------|----------------|
| `FIRECRAWL_API_KEY` | Chartmetric scrape |
| `STATS_CRON_SECRET` | Scheduled refresh (recommended) |
| `ARTIST_USER_ID` | Optional; pin artist if multiple profiles |
| `FANFUEL_HUB_KEY` | Control Center bridge (existing) |

### 3. Database migration (Lovable tool)

Paste and run: `lovable-migrations/20260525120000_fan_data_unique.sql`

### 4. Schedule (pick one)

**A — Recommended:** Supabase Dashboard → Edge Functions → `refresh-platform-stats` → Schedules

- Cron: `0 6 * * *`
- POST `{}`
- Header: `x-stats-cron-secret: <STATS_CRON_SECRET>`

**B — SQL:** `lovable-migrations/20260525120001_stats_refresh_cron.sql` (replace placeholder secret)

### 5. Inner Circle Telegram (separate from stats cron)

See `TELEGRAM_SETUP.md`. After GitHub push: Lovable **Publish**, set `INNER_CIRCLE_*` secrets, register webhook. Frontend CTA: `src/components/InnerCircleSubscribeButton.tsx`.

### 6. Smoke test (platform stats)

```bash
curl -sS -X POST "https://vsemrziqxrrfcquxfnwd.supabase.co/functions/v1/refresh-platform-stats" \
  -H "Content-Type: application/json" \
  -H "x-stats-cron-secret: $STATS_CRON_SECRET" \
  -d '{}'
```

Then in SQL: `SELECT fan_identifier, updated_at FROM fan_data ORDER BY updated_at DESC LIMIT 15;`

## CLI (optional — requires Supabase org access to project `vsemrziqxrrfcquxfnwd`)

Lovable-managed projects may **not** appear in your personal Supabase org. CLI deploy then returns `403`. If you own the project ref:

```bash
supabase login
supabase functions deploy draft-pitch approve-draft enrich-curator-contacts schedule-follow-up playlist-admin-api --project-ref vsemrziqxrrfcquxfnwd
```

## Lovable limitation: **new** edge function names

**Publish / Update redeploys existing functions only.** Adding a new folder under `supabase/functions/` and pushing to GitHub does **not** register that function name in Lovable/Supabase until something explicitly creates it (historically: one-time Lovable AI chat, or Supabase CLI deploy with project access).

**Symptom:** curl to `/functions/v1/draft-pitch` → `404`; existing functions like `playlist-research` → `401` (deployed).

**Workaround (no Lovable chat):** Playlist-agent endpoints are also mounted on **`control-center-api`** via `action`:

| Standalone URL (404 until registered) | `control-center-api` body |
|---|---|
| `draft-pitch` | `{ "action": "draft_pitch", ... }` |
| `approve-draft` | `{ "action": "approve_draft", ... }` |
| `enrich-curator-contacts` | `{ "action": "enrich_curator_contacts", ... }` |
| `schedule-follow-up` | `{ "action": "schedule_follow_up", ... }` |
| `playlist-admin-api` | `{ "action": "list_targets" \| "list_drafts" \| ... }` |

Admin UI (`src/lib/hubApi.ts`) routes through `control-center-api` automatically. After pushing this change: **Lovable → Publish** once — only `control-center-api` must redeploy.

Smoke test (no new function names required):

```bash
curl -sS -X POST "https://vsemrziqxrrfcquxfnwd.supabase.co/functions/v1/control-center-api" \
  -H "x-api-key: $FANFUEL_HUB_KEY" -H "content-type: application/json" \
  -d '{"action":"list_targets","lane":"deep_house_groove"}'
```

## Frontend env: `VITE_FANFUEL_HUB_KEY`

Admin pages (`/admin/playlists`, `/admin/outreach`, campaign send) need the hub key in **Vite** env (browser), not only Supabase Edge secrets:

1. Lovable → **Project settings** → **Environment variables** (or Cloud panel where `VITE_*` vars live)
2. Add `VITE_FANFUEL_HUB_KEY` = same value as backend secret `FANFUEL_HUB_KEY`
3. Republish frontend

Local dev: add to `.env` (never commit the real key).

## CLI (legacy single-function example)

```bash
supabase link --project-ref vsemrziqxrrfcquxfnwd
supabase functions deploy refresh-platform-stats
# …repeat per changed function
```
