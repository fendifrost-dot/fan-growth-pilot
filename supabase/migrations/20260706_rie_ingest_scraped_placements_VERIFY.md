# RIE Phase 1.1 — verification queries

Run these in the Lovable SQL editor **after** applying
`20260706_rie_ingest_scraped_placements.sql`. Read-only.

## 1) New counts — did the scraped data land?

```sql
-- history events by type (expect placement + spin > 0 now)
SELECT event_type, count(*) AS events
FROM public.relationship_history
GROUP BY event_type
ORDER BY events DESC;

-- placement events by source (playlist_targets = Spotify warm, apple_station_plays = radio)
SELECT source, count(*) AS placement_events
FROM public.relationship_history
WHERE event_type = 'placement'
GROUP BY source
ORDER BY placement_events DESC;

-- relationships by type, with supporters + avg score
SELECT relationship_type,
       count(*)                              AS total,
       count(*) FILTER (WHERE is_supporter)  AS supporters,
       round(avg(relationship_score))        AS avg_score
FROM public.relationships
GROUP BY relationship_type
ORDER BY relationship_type;

-- headline: total supporters now (was 0 before)
SELECT count(*) AS supporters_total
FROM public.relationships
WHERE is_supporter;
```

## 2) The money query — "who already supported this song?"

Swap the `ILIKE` pattern for each song (`%exhaust%`, `%meditate%`,
`%choose your enemies%`).

### Apple radio — stations that spun it (song → station is exact here)

```sql
-- via the new relationship rollup
SELECT r.name AS station, r.territory, sum(sp.spins_total) AS spins,
       max(sp.snapshot_week) AS latest_week
FROM public.apple_station_plays sp
JOIN public.relationships r ON r.dedupe_key = 'station:' || sp.station_id
WHERE sp.song_name ILIKE '%exhaust%'
GROUP BY r.name, r.territory
ORDER BY spins DESC;

-- raw fallback (no join, works even if BLOCK B relationships were skipped)
SELECT station_call_sign AS station, city, area_name,
       sum(spins_total) AS spins, max(snapshot_week) AS latest_week
FROM public.apple_station_plays
WHERE song_name ILIKE '%exhaust%'
GROUP BY station_call_sign, city, area_name
ORDER BY spins DESC;
```

### Spotify — warm curators/playlists featuring it

Note: on the Spotify side the exact song title is only weakly captured
(`featuring_tracks` holds matched artist-name strings for `spotify_placement`,
and a placeholder for `spotify_for_artists_csv`). Filtering by song may miss
rows — drop the `AND (... ILIKE ...)` line to list ALL warm Spotify supporters.

```sql
SELECT curator_name, playlist_name, follower_count, submission_url,
       research_context->>'source'          AS source,
       research_context->>'featuring_tracks' AS featuring_tracks
FROM public.playlist_targets
WHERE research_context->>'source' IN ('spotify_placement','spotify_for_artists_csv')
  AND (playlist_name ILIKE '%exhaust%'
       OR research_context->>'featuring_tracks' ILIKE '%exhaust%')
ORDER BY follower_count DESC NULLS LAST;
```

## 3) Cross-channel: top supporters overall

```sql
SELECT r.relationship_type, r.name, r.territory,
       r.relationship_score, r.audience_size,
       count(*) FILTER (WHERE h.event_type = 'placement') AS placements,
       count(*) FILTER (WHERE h.event_type = 'spin')      AS spin_events
FROM public.relationships r
LEFT JOIN public.relationship_history h ON h.relationship_id = r.id
WHERE r.is_supporter
GROUP BY r.id, r.relationship_type, r.name, r.territory,
         r.relationship_score, r.audience_size
ORDER BY r.relationship_score DESC, placements DESC
LIMIT 40;
```
