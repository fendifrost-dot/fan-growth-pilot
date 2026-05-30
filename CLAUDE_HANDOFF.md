# Claude handoff — FanFuel Hub (Fan Growth Pilot)

> **2026-05-28 — Outreach / IG / SFA CSV (execute next):** see **`docs/HANDOFF_CLAUDE_OUTREACH_DEPLOY.md`** for uncommitted IG roster + operator briefs + Spotify for Artists CSV import, migration `20260531`, deploy, and seeding `Fendi Frost-playlists-1year.csv`.

**Date:** 2026-05-24  
**Repo:** https://github.com/fendifrost-dot/fan-growth-pilot (`main` @ `11d7bb1`)  
**Lovable:** https://lovable.dev/projects/4778d2a5-781c-45e5-b165-9497cdba4918  
**Supabase project:** `vsemrziqxrrfcquxfnwd`  
**Local workspace:** `artistgrowthhub-repo` (same repo as fan-growth-pilot)

This is an **internal ops** stack (Control Center, artist dashboard, pitch tooling). Fans only touch public surfaces: smart links, email capture, Telegram signup — not admin stats APIs.

---

## 1. Workflow rules (read first)

| Edit in **GitHub** → syncs to Lovable | Edit in **Lovable only** |
|--------------------------------------|---------------------------|
| `supabase/functions/*/index.ts` | DB schema, RLS, triggers, row data |
| `src/`, `config.toml`, `package.json` | Run **migrations** (migration tool or SQL editor) |
| `supabase/migrations/*.sql` in repo | GitHub migration files are **version control only** — paste into Lovable to apply |

**Do not use Lovable's AI chat** for code or schema (credits + silent drift). SQL Editor is OK for reads/one-offs; migration tool is canonical for committed schema.

**After every GitHub push:** Lovable → **Publish** (push alone may not deploy edge functions).

---

## 2. What Cursor shipped (on `main`)

### Platform stats (why numbers looked “stuck”)

| Issue | Fix |
|-------|-----|
| `fetch-public-spotify-data` hardcoded defaults | Requires body fields; 400 if missing |
| `control-center-api` no `user_id` scope | Scoped to `ARTIST_USER_ID` or first `profiles` row |
| CC only read 4 `fan_identifier` keys | Full platform list + YouTube merge |
| `scrape-chartmetric` silent DB errors | Log + throw on upsert failure |
| `youtube_chartmetric_stats` vs `youtube_channel_stats` | fan-intelligence fallback; CC prefers OAuth row |
| No scheduler | New `refresh-platform-stats` chains scrape → fan-intelligence |
| `project-stats` misleading name | Returns table counts only (documented in response) |
| `spotify-stats` | Does **not** write `fan_data` (artist metrics = scrape-chartmetric) |

### Inner Circle Telegram

| Piece | Status on `main` |
|-------|------------------|
| DB tables + dedupe | Applied in prod (SQL editor); migrations in repo |
| `telegram-webhook`, `telegram-signup-redirect`, `telegram-send-campaign` | On `main` (`340c901`+) |
| Smart link CTA | `InnerCircleSubscribeButton` + `SmartLinkPage` (`f8c30ac`) |
| Schema vs code | Verified — see `supabase/INNER_CIRCLE_SCHEMA_VERIFY.md` |

**Critical:** Inner Circle uses a **NEW** BotFather bot (`INNER_CIRCLE_*` env). **Never** point `@FendiAIbot` at this webhook — see `CC_RECONCILIATION.md` in Fan Fuel Hub docs folder.

---

## 3. Execute checklist (in order)

### Phase A — Deploy code

- [ ] Confirm GitHub `main` is at `11d7bb1` or later
- [ ] Lovable → **Publish** (edge functions + frontend)

### Phase B — Secrets (Lovable → Cloud → Secrets)

| Secret | Purpose |
|--------|---------|
| `FANFUEL_HUB_KEY` | Control Center + pitch + telegram broadcast |
| `FIRECRAWL_API_KEY` | `scrape-chartmetric` |
| `STATS_CRON_SECRET` | `openssl rand -hex 32` — scheduled stats |
| `ARTIST_USER_ID` | Optional UUID if multiple `profiles` rows |
| `INNER_CIRCLE_BOT_TOKEN` | **New** bot only |
| `INNER_CIRCLE_BOT_USERNAME` | e.g. `FendiInnerCircle` |
| `INNER_CIRCLE_WEBHOOK_SECRET` | `openssl rand -hex 32` |

### Phase C — Database (Lovable migration tool)

Paste and run (in order):

1. `supabase/lovable-migrations/20260525120000_fan_data_unique.sql` — dedupe + unique index on `fan_data`

Optional cron SQL (only if Edge schedules unavailable):

2. `supabase/lovable-migrations/20260525120001_stats_refresh_cron.sql` — replace `YOUR_STATS_CRON_SECRET` first

### Phase D — Scheduled stats refresh

**Preferred:** Supabase → Edge Functions → `refresh-platform-stats` → Schedule

- Cron: `0 6 * * *`
- Method: POST, body `{}`
- Header: `x-stats-cron-secret: <STATS_CRON_SECRET>`

### Phase E — Telegram webhook (after Inner Circle bot exists)

```bash
curl -X POST "https://api.telegram.org/bot${INNER_CIRCLE_BOT_TOKEN}/setWebhook" \
  -H "content-type: application/json" \
  -d "{
    \"url\": \"https://vsemrziqxrrfcquxfnwd.supabase.co/functions/v1/telegram-webhook\",
    \"secret_token\": \"${INNER_CIRCLE_WEBHOOK_SECRET}\",
    \"allowed_updates\": [\"message\"],
    \"drop_pending_updates\": false
  }"
```

### Phase F — Smoke tests

**Stats:**

```bash
curl -sS -X POST "https://vsemrziqxrrfcquxfnwd.supabase.co/functions/v1/refresh-platform-stats" \
  -H "Content-Type: application/json" \
  -H "x-stats-cron-secret: $STATS_CRON_SECRET" \
  -d '{}'
```

```sql
SELECT fan_identifier, updated_at
FROM fan_data
ORDER BY updated_at DESC
LIMIT 15;
```

**Inner Circle:**

1. Phone → `https://vsemrziqxrrfcquxfnwd.supabase.co/functions/v1/telegram-signup-redirect?slug=inner-circle`
2. Telegram START → 🐻‍❄️ welcome (polar bear ZWJ, not brown bear)
3. SQL: `SELECT id, telegram_chat_id, subscribed, source_smart_link FROM telegram_subscribers ORDER BY subscribed_at DESC LIMIT 5;`
4. `/stop` → resubscribe via link again

**Broadcast test:**

```bash
curl -X POST "https://vsemrziqxrrfcquxfnwd.supabase.co/functions/v1/telegram-send-campaign" \
  -H "x-api-key: $FANFUEL_HUB_KEY" \
  -H "content-type: application/json" \
  -d '{"mode":"test","to_chat_id":"<your_chat_id>","text":"🐻‍❄️ test\\.\\n\\nfendi here\\."}'
```

---

## 4. Platform stats architecture

```text
WRITERS → fan_data:
  scrape-chartmetric, youtube-stats, soundcloud-stats, fetch-public-spotify-data (manual)

ORCHESTRATOR (cron):
  refresh-platform-stats → scrape-chartmetric → fan-intelligence

READERS:
  control-center-api (FANFUEL_HUB_KEY)
  fan-intelligence (snapshots, momentum)
  Lovable UI (direct SELECT on fan_data)

NOT writers:
  project-stats (table row counts)
  spotify-stats (/me JSON only)
```

### `fan_identifier` contract

`spotify_artist_stats`, `instagram_stats`, `facebook_stats`, `x_stats`, `shazam_stats`, `tiktok_stats`, `pandora_stats`, `chartmetric_overview`, `youtube_channel_stats`, `youtube_chartmetric_stats`, `soundcloud_user_stats`

### Inner Circle CTA on smart links

Shows when slug is `inner-circle` OR `smart_links.metadata.inner_circle_enabled` is true.

- Component: `src/components/InnerCircleSubscribeButton.tsx`
- Redirect: `telegram-signup-redirect?slug=...&email=...`

---

## 5. File map

| Purpose | Path |
|---------|------|
| Deploy runbook | `supabase/DEPLOY.md` |
| Function inventory + secrets | `supabase/PROJECT_INVENTORY.md` |
| Telegram setup | `supabase/TELEGRAM_SETUP.md` |
| Schema verify (telegram) | `supabase/INNER_CIRCLE_SCHEMA_VERIFY.md` |
| Lovable SQL paste | `supabase/lovable-migrations/` |
| Edge config | `supabase/config.toml` |
| Stats orchestrator | `supabase/functions/refresh-platform-stats/index.ts` |
| Control Center bridge | `supabase/functions/control-center-api/index.ts` |

**Fan Fuel Hub docs folder** (`~/Documents/Claude/Projects/Fan Fuel Hub/`):

| Doc | Topic |
|-----|--------|
| `INNER_CIRCLE_MARKETING_TECHNIQUE.md` | Strategy |
| `CC_RECONCILIATION.md` | FendiAIbot vs Inner Circle bot |
| `CURSOR_HANDOFF_INNER_CIRCLE.md` | Telegram build history (superseded by this file for ops) |
| `supabase-handoff.md` | Slim index (not full code dump) |

---

## 6. Blocked on Fendi (not Claude/Lovable code)

1. Create Inner Circle bot in BotFather (`@FendiInnerCircle` or similar) — **not** FendiAIbot
2. Set `INNER_CIRCLE_*` secrets
3. Phone end-to-end test after webhook registered
4. Confirm `FIRECRAWL_API_KEY` for live Chartmetric scrapes

---

## 7. Guardrails for Claude

- **Internal-only:** Do not expose hub keys or service-role patterns on fan-facing pages
- **Do not** call `project-stats` expecting Spotify/IG metrics
- **Do not** repoint FendiAIbot webhook to AGH `telegram-webhook`
- **Do not** apply schema by editing GitHub migrations only — use Lovable migration tool
- **Prefer** `refresh-platform-stats` for scheduled refresh over ad-hoc partial writers
- When patching smart links, CTA copy must use **🐻‍❄️** (polar bear ZWJ)

---

## 8. Git sync (local = GitHub)

```bash
cd /path/to/artistgrowthhub-repo   # or fan-growth-pilot clone
git remote -v   # should be fendifrost-dot/fan-growth-pilot
git pull origin main
git log -1 --oneline   # expect 11d7bb1 or newer
```

Repo is aligned; leftover untracked monorepo folders were removed by user.
