# Relationship Intelligence Engine — Phase 1: Apply Instructions

**What this is:** the memory/data foundation for RIE — a CRM layer whose primary
entity is the *person/organization* that already supported the catalog (Spotify
curators today; radio/blogs/creators modeled for later). It complements the
discovery engine — warm relationships get worked before discovery runs.

**Repo confirmed:** `origin → github.com/fendifrost-dot/fan-growth-pilot.git`
(Supabase `vsemrziqxrrfcquxfnwd`). Everything below is Lovable-managed — no CLI.

---

## 1. Run the migration (Lovable SQL editor)

Open the **Lovable SQL editor** and paste + run the entire file:

```
supabase/migrations/20260705_relationship_intelligence_engine.sql
```

It is **additive and idempotent** — safe to run once or re-run. It:

1. Creates enums `relationship_type`, `relationship_event_type`.
2. Creates 5 tables: `relationships`, `relationship_playlists`,
   `relationship_stations`, `relationship_shows`, `relationship_history`.
3. Creates the scoring function `rie_relationship_score()` + bulk driver
   `rie_recompute_scores()`.
4. **Backfills** from existing data: `playlist_targets` → relationships +
   playlist bridges + `discovered` history; `pitch_log` → `pitch_sent` / `reply`
   / `placement` history; then rolls contact/reply dates up and computes scores.
5. Creates read view `v_relationship_summary`.
6. Enables RLS (service-role only, exactly like `playlist_targets`).

## 2. Verify (paste into SQL editor after)

```sql
SELECT count(*) FROM public.relationships;
SELECT count(*) FROM public.relationship_playlists;
SELECT count(*) FROM public.relationship_history;

-- distribution
SELECT relationship_type, count(*), round(avg(relationship_score)) avg_score,
       count(*) FILTER (WHERE is_supporter) supporters
  FROM public.relationships GROUP BY 1;

-- your warmest known supporters
SELECT name, relationship_score, outreach_status, audience_size
  FROM public.relationships ORDER BY relationship_score DESC LIMIT 20;
```

Expect: `relationships` count ≈ distinct curators (fewer than playlist rows,
because many playlists roll up to one curator); `relationship_playlists` ≈ your
`playlist_targets` row count; supporters = curators with a confirmed placement.

## 3. Redeploy?

**Not needed for Phase 1.** The backfill runs inside the SQL migration — there is
no edge-function change. (Continuous ingestion + the admin UI are Phase 2.)

---

## Scoring v1 weights (documented)

`relationship_score` is 0–100, `= 100 × clamp(Σ, 0, 1)`:

| Weight | Signal | v1 definition |
|---|---|---|
| 0.35 | placement | 1 song placed → 0.6, 2+ → 1.0 |
| 0.15 | reply | replied once → 0.6, 2+ → 1.0 |
| 0.15 | retention | follower growth across their playlists (0 where no snapshots) |
| 0.10 | genre_match | 1.0 if we have a lane/genre for them, else 0.5 (proxy; real catalog similarity is a later phase) |
| 0.10 | audience | ln(followers)/ln(1e6), clamped |
| 0.10 | recency | linear decay, 1.0 today → 0 at 365d since `last_active` |
| 0.05 | confidence | `contact_confidence` / 10 |

Tiers: **0–30 cold · 31–60 warm · 61–100 hot**. `is_supporter = true` whenever a
confirmed placement exists.

## Honest data-source accounting

- **Populated now:** Spotify curators, their playlists, discovery/pitch/placement
  history, contact fields — all from data we already scrape.
- **Retention** is only computed where `follower_snapshots` exist (that table
  isn't auto-populated yet), so most retention signals are 0 today — honest, not
  fabricated. Wiring a scheduled follower snapshot is a Phase 2 item.
- **Radio** (`relationship_stations` / `relationship_shows`): schema is built so
  the model is complete, but **nothing is ingested** — Apple Music for Artists
  spin data (`apple_station_plays`) is a template, not a live feed yet. Flagged
  in the migration; it populates once a spin source exists.

## Designed-for later phases (NOT built)

Similar-song supporter recall · release-workflow ranking (search DB → rank by
score → outreach list → messaging → *then* discovery) · contact enrichment w/
confidence · scheduled monitoring appending history · "X matches N previous
supporters" notifications · full lead tracking. The schema already supports all
of these; no Phase-1 code exists for them.
