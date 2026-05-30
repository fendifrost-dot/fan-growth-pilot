# Claude handoff — IG outreach, SFA CSV import, deploy & seed

**Date:** 2026-05-28  
**Repo:** https://github.com/fendifrost-dot/fan-growth-pilot  
**Local path:** `/Users/gocrazyglobal/artistgrowthhub-repo`  
**Supabase project:** `vsemrziqxrrfcquxfnwd`  
**Lovable:** https://lovable.dev/projects/4778d2a5-781c-45e5-b165-9497cdba4918  
**Production admin:** `app.bemoremodest.com/admin/*`

**Parent docs:** `CLAUDE_HANDOFF.md` (platform-wide), `docs/GROWTH_WORKFLOW.md` (operator playbook)

---

## 0. Rules (do not skip)

1. **GitHub push ≠ live.** After push: Lovable → **Publish**, then redeploy **`control-center-api`** (and any touched edge functions).
2. **Migrations:** Files under `supabase/migrations/` are version control only — run SQL in **Lovable migration tool** or SQL Editor.
3. **Do not commit** `.env`, hub keys, or user CSVs from `~/Downloads/`.
4. **Do not use Lovable AI chat** for code/schema.
5. Admin UI uses **session JWT** to CCA (`callHubFn`), not browser hub key — see `docs/HANDOFF_ADMIN_JWT_AUTH.md`.

---

## 1. What was completed (local — NOT all on `main` yet)

Verify with `git status`. As of handoff, these changes are **uncommitted** on the working tree:

### A. IG DM organization (mutual-follow gate + operator brief)

| Piece | Path / action |
|-------|----------------|
| DB migration | `supabase/migrations/20260531_ig_roster_and_dm_brief.sql` |
| Roster table | `instagram_curator_roster` (`follows_me`, `i_follow`, generated `is_mutual`) |
| Queue columns | `social_engagement_queue`: `ig_handle`, `dm_ref`, `operator_brief` |
| Brief vs DM body | `supabase/functions/_shared/outreach-templates.ts` |
| Mutual gate + batch queue | `supabase/functions/_shared/ig-outreach.ts`, `ig-roster.ts` |
| Catalog auto-match | `supabase/functions/_shared/catalog-match.ts` |
| CCA actions | `list_ig_roster`, `patch_ig_roster`, `import_ig_roster`, `sync_ig_roster_from_targets` |
| Admin roster UI | `/admin/ig-roster` → `src/pages/admin/AdminIgRoster.tsx` |
| IG queue UI | `/admin/ig-queue` — copy **message** vs **brief** separately |

**Behavior:** `queue_ig_outreach_batch` defaults `require_mutual: true`. Skips curators not on roster or not mutual.

### B. Placement email (mirror IG identity)

- `draft_pitch` on warm placements uses structured email + `operator_brief` in draft `metadata` (same REF / mutual / playlist context as IG).
- Warm sources: `spotify_placement` **or** `spotify_for_artists_csv` (`placement-sources.ts`).

### C. Spotify for Artists CSV import (user’s 1-year report)

| Piece | Path / action |
|-------|----------------|
| Parser + ingest | `supabase/functions/_shared/spotify-for-artists-csv.ts` |
| CCA action | `import_spotify_for_artists_csv` |
| Admin upload | `/admin/playlists` → “Spotify for Artists — playlist report (CSV)” |
| CLI script | `scripts/import-sfa-placements.sh` |
| User file (local only) | `/Users/gocrazyglobal/Downloads/Fendi Frost-playlists-1year.csv` |

**Expected parse (tested locally):** 68 rows → **~44 curator playlists** kept; ~24 skipped (Spotify algorithmic / editorial).

CSV columns: `title`, `author`, `listeners`, `streams`, `date_added`.

---

## 2. What Claude should do next (ordered)

### Step 1 — Commit & push (if user wants this on `main`)

Only if explicitly asked. Suggested scope — **exclude** junk:

```bash
cd /Users/gocrazyglobal/artistgrowthhub-repo
git add \
  docs/GROWTH_WORKFLOW.md \
  docs/HANDOFF_CLAUDE_OUTREACH_DEPLOY.md \
  src/App.tsx src/pages/admin/Admin*.tsx \
  supabase/functions/_shared/*.ts \
  supabase/functions/control-center-api/index.ts \
  supabase/migrations/20260531_ig_roster_and_dm_brief.sql \
  scripts/import-sfa-placements.sh
# Do NOT add: supabase/.temp/, _avt-worktree/, deno.lock unless team wants it
git commit -m "$(cat <<'EOF'
Add IG mutual roster, operator DM briefs, and Spotify for Artists CSV placement import.

EOF
)"
git push origin main
```

If push rejected (remote ahead): `git pull --rebase origin main` then push again.

### Step 2 — Apply database migration (Lovable)

Run **`supabase/migrations/20260531_ig_roster_and_dm_brief.sql`** in Lovable migration tool (or SQL Editor).

Confirm:

```sql
SELECT column_name FROM information_schema.columns
WHERE table_name = 'social_engagement_queue' AND column_name IN ('ig_handle','dm_ref','operator_brief');

SELECT column_name FROM information_schema.columns
WHERE table_name = 'instagram_curator_roster' AND column_name = 'is_mutual';
```

### Step 3 — Deploy

1. Lovable → **Publish** (frontend + edge).
2. Confirm **`control-center-api`** includes new actions (no `Unknown action` on smoke calls).

**Smoke (hub key or admin JWT):**

```bash
# Replace URL/key from Lovable secrets — never paste keys in chat logs
curl -sS -X POST "$FANFUEL_HUB_URL" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $FANFUEL_HUB_KEY" \
  -d '{"action":"list_ig_roster","mutual_only":false}' | head -c 500
```

### Step 4 — Import SFA CSV (seed placements now)

**Option A — Admin UI (preferred)**

1. Open `https://app.bemoremodest.com/admin/playlists` (or local dev).
2. Section **“Spotify for Artists — playlist report (CSV)”**.
3. Report label: `1year`.
4. Upload: `Fendi Frost-playlists-1year.csv` from Downloads.
5. Leave **Resolve Spotify URLs** unchecked on first pass (faster).
6. Enable filter **Placements only** — expect ~44 rows with stream counts.

**Option B — CLI (after Step 3)**

```bash
export FANFUEL_HUB_URL="https://vsemrziqxrrfcquxfnwd.supabase.co/functions/v1/control-center-api"
export FANFUEL_HUB_KEY="<from Lovable secrets>"
./scripts/import-sfa-placements.sh \
  "/Users/gocrazyglobal/Downloads/Fendi Frost-playlists-1year.csv" \
  1year
```

### Step 5 — Weekly SFA refresh (standing process)

Every week (e.g. Monday):

1. Spotify for Artists → Playlists → download new CSV.
2. `/admin/playlists` → upload with label e.g. `2026-w22`.
3. Optional: check **Deactivate rows missing from this file** if the export is a full snapshot.
4. Re-run **Enrich contacts** on placement rows.

### Step 6 — IG outreach workflow (after placements exist)

1. **`/admin/ig-roster`** → **Sync from playlists** → in Instagram app verify each curator → toggle **I follow** + **Follows me** (mutual).
2. **`/admin/playlists`** → **Enrich contacts** (resolves `spotify:sfa:*` rows by playlist name when Firecrawl works).
3. **Queue 10 IG DMs (mutual)** — requires roster mutual flags; uses auto catalog match if track field empty.
4. **`/admin/ig-queue`** — read **operator brief**, paste **message only**, **Mark sent** (10/day UTC cap).
5. Email curators: **Draft** on row → **`/admin/outreach`** → approve & send.

### Step 7 — Verify end-to-end

| Check | Pass criteria |
|-------|----------------|
| `import_spotify_for_artists_csv` | `ingested` + `updated` > 0, skipped includes `spotify_owned` / `algorithmic_title` |
| `list_targets` + `placement_only: true` | ~44 SFA rows visible |
| `list_ig_roster` | Rows after sync |
| `queue_ig_outreach_batch` | Queues only mutual; skipped reasons documented |
| `list_social_queue` | Rows have `dm_ref`, `operator_brief`, clean `draft_text` |
| `get_outreach_stats` | `ig_roster_mutual`, `ig_roster_total` present (after migration) |
| `draft_pitch` on SFA row with email | Subject includes REF; metadata has `operator_brief` |

---

## 3. Known gaps / do not assume done

| Item | Notes |
|------|--------|
| Auto IG Graph follower sync | Not built — mutual flags are **manual** on `/admin/ig-roster` |
| `instagram-messaging` edge fn | Exists but not wired for full follower import |
| SFA rows without Firecrawl resolve | IDs like `spotify:sfa:<hash>` until enrich/search finds real playlist |
| All uncommitted work on disk | Must commit + publish before prod matches this handoff |
| Prior deploy items | Apple radio, pitch_log fix, Send center — may already be on `main`; confirm `git log` |

---

## 4. File map (quick reference)

```
supabase/migrations/20260531_ig_roster_and_dm_brief.sql
supabase/functions/_shared/
  outreach-templates.ts      # operator brief + DM body + placement email
  ig-roster.ts                 # roster CRUD
  ig-outreach.ts               # batch queue + mutual gate
  catalog-match.ts             # pickCatalogTrackForPlacement
  spotify-for-artists-csv.ts   # CSV import
  placement-sources.ts         # warm placement source set
  playlist-agent-run.ts        # wires actions + draft_pitch + enrich sfa resolve
supabase/functions/control-center-api/index.ts  # get_outreach_stats + roster counts
src/pages/admin/
  AdminIgRoster.tsx
  AdminSocialQueue.tsx
  AdminPlaylistTargets.tsx   # SFA CSV upload card
scripts/import-sfa-placements.sh
docs/GROWTH_WORKFLOW.md
```

---

## 5. Copy-paste prompt for Claude

```
You are continuing Fan Growth Pilot outreach work in artistgrowthhub-repo.

Read docs/HANDOFF_CLAUDE_OUTREACH_DEPLOY.md and execute Steps 1–7 in order:
1) Commit/push only if the user asked — otherwise skip.
2) Apply migration 20260531_ig_roster_and_dm_brief.sql in Lovable.
3) Publish + verify control-center-api actions.
4) Import /Users/gocrazyglobal/Downloads/Fendi Frost-playlists-1year.csv via admin or scripts/import-sfa-placements.sh.
5) Document weekly SFA re-import in GROWTH_WORKFLOW if anything changed.
6) Walk through IG roster → enrich → queue → ig-queue smoke test.
7) Report ingested/skipped counts and any CCA errors.

Do not expose secrets. Do not force-push main.
```

---

## 6. Success message back to user

When done, report:

- Migration applied: yes/no  
- CCA deployed: yes/no  
- SFA import: `ingested`, `updated`, `skipped` breakdown  
- Placements visible in admin: count  
- IG queue test: queued / skipped (mutual)  
- Blockers (missing secrets, migration failure, Unknown action)
