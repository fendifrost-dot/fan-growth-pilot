# AGH playlist run log — where it lives

The run log is **`daily_ops_station_runs`** in the Hub (one row per station run, with
`metrics`, `shortfall_reason`, `saturation_indicators`). Read it with
`get_playlist_discovery_work` (today's funnel) and `get_own_playlist_batches`. The Drive
run-log documents are secondary copies for humans.

**But:** a Drive log is where a run records what the standing files are missing. Since
11-02 the productive surface (section 1 of `agh-playlist-supply-blockers.md`) lived only in
those Drive logs, and two scheduled runs re-spent the dead re-verify pool because the
GitHub files said the open web was dead. When a run finds something these three files do
not say, it writes it under "FOR THE STANDING FILES" in its log **and names it in
`complete_claude_playlist_station.notes`** so Fendi/Cursor can promote it here. A finding
that reaches only a Drive doc is not yet a rule.

Recent, from the Hub:

| Date (CT) | Station | Status | Drafted | Note |
|---|---|---|---|---|
| 2026-10-22 | playlist_discovery_begin | partial | 2 | 74 raw / 53 unique / 3 verified / 2 drafted; 1 refused on operator cooldown (Curativ, pitched 2026-10-03). |
| 2026-10-22 | playlist_tranche_first | partial | 0 | Re-verify pool yielded no submittable rap rows. |
| 2026-10-22 | playlist_tranche_final | partial | 0 | Nothing at CLAUDE_BATCH_READY for the day. |
| 2026-10-22 | (Instagram, by directive) | — | 5 | Five Claude-authored Instagram drafts re-issued for the 10-22 pack; Grok approved all five 15:54 UTC. |
| 2026-10-30 | — | — | — | Stored-lane defect first logged: 7 ids refused on the stored `playlist_targets.lane`, submitted lane ignored. |
| 2026-11-02 | playlist_tranche_first | partial | 0 | Re-verify pool recorded EXHAUSTED. Log claimed "every open-web route-bearing surface disqualified" — too strong, see 11-03. |
| 2026-11-03 | playlist_tranche_first (run `13343ff3`) | partial | 17 | All 17 from `playlistlookup.com/genre/<slug>` (8 pages). Re-verify pool: 40 submitted → 1 verified → 0 drafted (4th run). 3 new blocked operator groups. [Drive log](https://docs.google.com/document/d/1AYesA5HU_Njs1BPLdUp_X30n5YCIL4tENxbZuGExHqw/edit). |
| 2026-11-03 | playlist_tranche_final | partial | — | Re-spent the exhausted re-verify pool while playlistlookup (found 3h earlier) went unused — the routine defect. |
| 2026-11-04 | playlist_discovery_begin (run `0100b7f9`) | partial | 8 | Closed once at 0 drafts on the re-verify pool alone (37 of 45 evaluations, 5th straight run at 0), resumed after reading the Drive logs, 8 drafts from playlistlookup in 8 min (batches `f9f70411` Meditate 3, `642cb6a7` DFM 5). Found the expired-cooldown trap (19 lapsed pairs returned as duplicates) and the three stored-id shapes. [Drive log](https://docs.google.com/document/d/1SCBaqrQCq4oJYuIEyOCJzxxIeLFiUdXeJAE_Ro0eHh8/edit). |
| 2026-11-04 | (code, not a run) | CODED | — | Cooldown release + verify-time contact policy committed to `fan-growth-pilot`; LIVE only after `mcp-playlist-discovery` redeploy. `docs/HANDOFF_PLAYLIST_COOLDOWN_RELEASE_2026-11-04.md`. |

Grok review activity, last 10 days to 10-22: rejections most days, approvals on 10-13,
10-14, 10-15 and 10-22; email sends go through the approve-and-send path (107 in 10 days);
Instagram sends stopped 10-14 until the Muse path shipped 10-22. From 10-31 to 11-04
`submissions_today` was 0 on both songs on every run; Grok's queue held 545 (Meditate) and
491 (DFM) rejections at the 11-04 close.

A run appends one row here only when something changed the standing rules or blockers;
otherwise the Hub row is the log.
