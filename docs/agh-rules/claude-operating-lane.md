# Claude operating lane — AGH playlist + sync discovery (standing rules)

Version-controlled home for the rules the daily Claude discovery routines must read first.
Supersedes the `agh-amendment-*` memory entries, which a cloud run cannot read. When a rule
here conflicts with a routine prompt, this file wins and the prompt is stale: say so in the run
log and follow this file.

Last ruled: 2026-11-04 (Fendi, via Claude Code; §2.8–2.10 and the §2.4 note added from the
11-03 / 11-04 run logs). Earlier sources: `docs/HANDOFF_PLAYLIST_ROUTES_THROUGHPUT_2026-09-27.md` §4,
`docs/HANDOFF_PLAYLIST_SEPT28_FINDINGS_2026-09-28.md` §6, `docs/HANDOFF_AGH_QUEUE_RECONCILIATION_2026-10-13.md` §4,
`docs/HANDOFF_IG_SEND_PATH_MUSE.md`, `docs/HANDOFF_PLAYLIST_COOLDOWN_RELEASE_2026-11-04.md`.

## 1. System of record

The Hub is the system of record. A Drive doc, a Gmail, or a board note is a report about
work, never the work. Anything not written to the Hub through an MCP tool did not happen for
the pipeline. "AWAITING_AGH_IMPORT" is a Hub queue state on a Hub batch; it is not a label
for a Drive document.

## 2. Playlist lane

1. Inventory lands at `AWAITING_GROK_REVIEW` when `create_playlist_draft_inventory` returns.
   No station-close promotion is needed.
2. **Cross-day promotion is allowed.** A batch stranded at `CLAUDE_BATCH_READY` with its
   route holds released is cleared with `advance_playlist_batches([...ids])` on any business
   date. Any prompt text calling this "disproven" is stale. A batch that still holds a
   route-held record is skipped by the tool (`route_hold_unresolved`); that is correct, not a
   failure to report.
3. `effective_raw_target` and `daily_raw_requirement` are **read from the
   `get_playlist_discovery_work` payload every run**. They move with the measured
   raw→verified conversion (180 on 2026-10-22 at 0.335; 101 on 2026-10-13 at 0.597). No
   number is hard-coded, including 102 and 1200. If the payload reads `measurement_status`
   `measured`, the number is right by definition.
4. The contact-policy cooldown is **per curator for 90 days across every channel and both
   songs**, keyed by playlist id, email, IG handle, form, Spotify owner id or
   `operator_group_id` (migration `20261006000000`). A brand-new playlist run by an operator
   pitched 19 days ago is refused on purpose. Report it as `policy_deferred` with the
   `cooldown_until`; it is not a bug and not a pair-keyed error.
   **A lapsed cooldown frees the pair.** A song–playlist pair whose last send is more than
   90 days old is eligible again and comes back `existing_verified_eligible` with a
   `prior_pitch` block; a pair still cooling is `deferred` (`pair_cooldown`, `retry_after`).
   Once `mcp-playlist-discovery` carries the 2026-11-04 fix, submit also applies the
   contact policy at verify time, so an existing target the draft step would refuse is
   `deferred` (`cooldown_conflict`, `classification: existing_policy_deferred`) rather than
   counted in `verified_eligible_count`. Before that redeploy, a duplicate reported as
   `existing_pair_already_pitched` with a **past** `cooldown_until` is the known trap in
   `agh-playlist-supply-blockers.md` §3 — name it in the run log, do not treat it as
   exhausted supply.
5. Prior structural rejections (login, paywall, captcha, dead form, follow gate) on the
   same route are not re-drafted. Fit rejections may requeue.
6. Allocation follows `per_song_funnel.discovery_allocation`. One song's surplus never
   covers another. Report `candidates_submitted_for_verification` as intake, never as
   submissions. Close `partial` with a `shortfall_reason` when stopping short.
7. Candidate fields (`curator_name`, `follower_count`, `submission_terms`,
   `login_required`) are passed only when read off the source. Never estimated.
8. **Surface order.** Discovery spends `agh-playlist-supply-blockers.md` §1 (the
   playlistlookup genre directory, unspent slugs first) **before** any WebSearch query and
   before the re-verify pool. `source_url` is the directory page that prints the row's
   handle or email, never a sibling page. Only slugs confirmed against `/genres` are
   fetched; a guessed slug is a wasted fetch and goes in the run log as such.
9. **Re-verify pool.** The `manually_verified_supply` block of `get_playlist_discovery_work`
   is **not spent** by a discovery run until `agh-playlist-supply-blockers.md` §2 says
   otherwise. After the 2026-11-04 cooldown fix is live, one page (25 rows) may be
   re-tested once; a 0-draft result ends the test and is logged.
10. **Standing files win over Drive logs, and gaps are reported upward.** A run reads
    these three files first. Anything productive or broken that they do not mention goes
    in the run log under "FOR THE STANDING FILES" **and** in
    `complete_claude_playlist_station.notes`. The run does not edit these files itself; it
    does not act on an earlier Drive log as if it were a rule, except to follow a surface
    the standing files already name.

## 3. Instagram path (Fendi directive 2026-10-22)

Claude composes every Instagram DM inside the Hub (`create_playlist_draft_inventory`,
`generated_by = claude_playlist_discovery`). Grok reviews the record and approves the draft.
Muse reads `list_ig_dm_send_queue` and sends. Muse records the receipt. There is no
hand-send lane and no author waiver. Drafts carry `send_owner = muse`.

## 4. Sync lane

1. Sync work is submitted through the **AGH Sync Discovery** MCP connector
   (`mcp-sync-discovery`, tools `start_claude_sync_station`, `submit_sync_targets`,
   `submit_sync_opportunities`, `create_sync_drafts`, `advance_sync_batch`,
   `complete_claude_sync_station`). The playlist connector cannot open a sync station
   (`station_ownership`) and `advance_playlist_batches` is not a sync intake.
2. Delivery to Grok **is** a sync batch at `AWAITING_AGH_IMPORT` in the Hub. Grok's
   `grok_sync_review` station (13:30 CT) reads it there. A Drive filing is not delivery; if
   the connector is missing from the run, say "not delivered" and stop. Do not substitute.
3. Drafts stay held while the AGH sync-eligible flag is absent. Sample status is never
   inferred.

## 5. Reporting

Every number comes from a Hub payload or a Hub query and says which. A claim with no Hub
row behind it is labeled OBSERVED or HYPOTHESIS, never VERIFIED. Credential or connector
gaps are named as "not available in this run", with the connector name.
