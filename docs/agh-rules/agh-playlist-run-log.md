# AGH playlist run log — where it lives

The run log is **`daily_ops_station_runs`** in the Hub (one row per station run, with
`metrics`, `shortfall_reason`, `saturation_indicators`). Read it with
`get_playlist_discovery_work` (today's funnel) and `get_own_playlist_batches`. The Drive
run-log documents are secondary copies for humans.

Recent, from the Hub:

| Date (CT) | Station | Status | Drafted | Note |
|---|---|---|---|---|
| 2026-10-22 | playlist_discovery_begin | partial | 2 | 74 raw / 53 unique / 3 verified / 2 drafted; 1 refused on operator cooldown (Curativ, pitched 2026-10-03). |
| 2026-10-22 | playlist_tranche_first | partial | 0 | Re-verify pool yielded no submittable rap rows. |
| 2026-10-22 | playlist_tranche_final | partial | 0 | Nothing at CLAUDE_BATCH_READY for the day. |
| 2026-10-22 | (Instagram, by directive) | — | 5 | Five Claude-authored Instagram drafts re-issued for the 10-22 pack; Grok approved all five 15:54 UTC. |

Grok review activity, last 10 days: rejections most days, approvals on 10-13, 10-14, 10-15
and 10-22; email sends go through the approve-and-send path (107 in 10 days); Instagram
sends stopped 10-14 until the Muse path shipped 10-22.

A run appends one row here only when something changed the standing rules or blockers;
otherwise the Hub row is the log.
