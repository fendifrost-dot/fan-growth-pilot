# Playlist-discovery connector fixes — 2026-09-26

Covers the six defects from `cursor-handoff-capacity-metric.md` and
`agh-consolidated-correction-2026-09-20.md` (neither file is in this repo; the summaries
in the task brief were treated as authoritative).

## Rollout (Lovable only — no standalone Supabase)

| Step | Where | Required? |
|------|-------|-----------|
| Redeploy edge function **`mcp-playlist-discovery`** | Lovable → Edge Functions | **Yes**: new tools and the capacity change ship here |
| Redeploy edge function **`control-center-api`** | Lovable → Edge Functions | Yes: `get_discovery_capacity_plan` uses the same `_shared/discovery-capacity.ts` |
| Frontend Publish | — | Not needed (no `src/` changes) |

After redeploy, reconnect or refresh the Claude connector so `tools/list` picks up the two new
tools. The server version is now `1.2.0`.

## What changed

### Fix 1: capacity / `daily_target` (`_shared/discovery-capacity.ts`)

- **Split funnel.**
  - `raw → verified` = Σ min(verified_targets, raw_discoveries) ÷ Σ raw_discoveries. It comes from
    `daily_ops_station_runs` (playlist stations, completed or partial, `completed_at` in the
    window). Runs that report `raw_discoveries = 0` are excluded.
  - `verified → draft` is measured separately. It is reported, but it is **never** used to
    size raw demand.
- **All channels.** `verified → draft` now counts `agh_handoff_records`, which includes
  email drafts and the web-form and IG-DM manual packets, plus `outreach_drafts`. Manual
  packets were already queryable (`agh_handoff_records.submission_channel`), so no schema
  change was needed.
- **Cohort fix.** The old query picked verified targets by `last_verified_at`, and
  re-verification sweeps refresh that on old catalog rows. It then looked for
  `outreach_drafts` created inside the window. So old, already-drafted, mostly form-only
  rows entered the denominator with no chance of a matching numerator. That pushes the rate
  toward zero and onto the 5% floor. The new cohort is path-verified targets **created** in
  the window, with drafts counted for those same targets.
- **Explicit states.** Every measurement reports one `status`:
  - `measured`
  - `measured_zero`
  - `no_data`: only this state uses the fallback rate, and it sets `fallback_used: true`
  - `query_failed`: carries `measurement_error`, with no rate and no estimate

  A query error never becomes `0`. A failed chunk fails the whole measurement; partial
  counts are never used.
- **Working exposed.** `daily_target` adds these fields:
  - measurement: `numerator`, `denominator`, `sample_size`, `window`, `conversion_rate`,
    `measurement_status`, `measurement_error`, `funnel`
  - fallback: `fallback_used`, `fallback_rate`
  - estimate: `daily_raw_requirement_basis`, `objective_verified_total`,
    `raw_research_capped` (always `false`)
  - `warnings`, `settings_status`
- **No research cap (updated 2026-09-26, follow-up).** Raw research is uncapped: the agent
  keeps researching until the verified objective is met or its sources saturate.
  - `effective_raw_target` equals `daily_raw_requirement`: the estimate from `raw → verified`
    only. It is guidance, not a limit, and is `null` when it can't be estimated.
  - The research budget that PR #38 briefly added (`research_budget_raw_per_song`) has been
    removed. Its optional SQL was deleted. If that SQL was already applied, the leftover
    `ops_settings` key is ignored.
  - The objective (`target_verified_per_song_per_day`, 30) is unchanged.

**Semantics change to note.** `effective_raw_target` no longer equals
`max(daily_raw_requirement, interim_raw_floor)`. `daily_raw_requirement` can now be `null`.
The old `trailing_conversion_rate` field is removed from the plan and replaced by
`funnel.*`. `AdminDailyOps` only JSON-dumps the plan, so nothing in the UI breaks.

### Fix 2: `advance_playlist_batches(batch_ids[])` (new tool)

- Takes up to 100 IDs.
- It advances only batches with `discovered_by = claude_playlist_discovery` and
  `batch_kind = playlist`, from `CLAUDE_BATCH_READY` or `CLAUDE_PLAYLIST_COMPLETE` to
  `AWAITING_GROK_REVIEW`.
- It does not depend on station runs or the business date.
- The caller can't pick a state: the schema is strict, the tool reuses
  `advanceClaudeReadyBatches` and `authorizeHandoffState`, and a ceiling check runs after.
- A batch owned by another actor returns `batch_not_found`, the same code as a missing
  batch.

### Fix 3: `get_batch_candidates(batch_id)` (new tool)

- Read-only, and limited to this actor's own batches (others return 404).
- It returns the records joined to `playlist_targets`: playlist identity (including
  `identity_resolved`), route, verification, evidence, packet, and outreach-draft status.
- Pitch copy (`body` / `subject` and similar) is stripped and never returned.

### Fix 4: route-only candidates

- **When a candidate is accepted route-only.** It has no Spotify ID, but it does have
  `playlist_name`, evidence, and a first-party route (`curator_email`, `form_url` or
  `ig_curator_account`). It is accepted **only if** `evaluateSubmissionPath` verifies the
  route.
- **Identity.** The ID is deterministic: `route-<sha256(channel|normalized route|normalized
  name)[:32]>`. Resubmitting the same route and name therefore dedupes onto the same
  target.
- **Dedupe first.** Before creating a new row, it checks existing targets with the same
  route and name, including rows that already have a real Spotify ID.
- **Flagging.** The row gets `research_context.identity_resolved = false` and
  `identity_kind = "route_only"`, and the tool response includes `identity_resolved`.
- **Catalog IDs.** Candidates may also pass the `playlist_id` of an existing catalog row,
  even one that isn't Spotify-shaped.

### Fix 5: `manually_verified` supply

- **Trigger.** A submitted candidate resolves to a `manually_verified` row that has
  `path_verified != true` or no known channel.
- **Re-verification.** The server re-runs `evaluateSubmissionPath` with the row's route
  plus the candidate's fresh evidence. Route fields from the candidate only fill gaps.
- **On success.** It sets `path_verified`, `last_verified_at` and notes, and sets the
  channel only if the row had none. `verification_status` and `verified_by` (the human
  verification) are never changed.
- **Eligibility.** The row is then re-classified through the normal lane, DNA, pair and
  cooldown checks.
- **Discovery.** `get_playlist_discovery_work.manually_verified_supply` lists up to 25 such
  rows (scanning 200), so the agent can find them.

### Fix 6: `playlist_targets.playlist_url`

This was **already fixed before this change**, using option (b):

- `buildDiscoveryPlaylistTargetInsert` stores the URL in `research_context.playlist_url`.
- `assertPlaylistTargetInsertSchema` rejects any row with a `playlist_url` key (fail
  closed, not a silent no-op). The existing test is
  `submit new Spotify candidate persists without playlist_url column`.
- No other insert or upsert into `playlist_targets` writes `playlist_url`
  (`playlist-research`, `spotify-placements`, `spotify-for-artists-csv` were checked).
- The route-only path goes through the same guard (tested).

Leftover: `discovery_profiles.dedupe_key_fields` still defaults to `['playlist_url', …]`.
Nothing reads that column, so it was left alone.

## Where the code differed from the diagnosis

- **Fix 1, "denominator excludes most output."** In code, the *numerator* was the
  email-only part (`outreach_drafts`). The denominator was all verified targets, and the
  cohort mismatch described above was the bigger driver.
- **Fix 2, promotion path.** Since `20260915120000_playlist_inventory_drafted_by_promote`,
  `create_playlist_draft_inventory` already promotes each new batch to
  `AWAITING_GROK_REVIEW` right after it persists. Stranded batches are the ones from before
  that change, or cases where promotion failed after persist (the tool returns
  `persisted: true` with a promotion error). `completeDailyStationRun` also accepts
  `output_batch_ids[]` internally, but the connector schema never exposed it, and that
  path doesn't check batch ownership. `advance_playlist_batches` is the owned,
  date-independent path.
- **Fix 5.** `manually_verified` rows that already had `path_verified = true` and a
  channel were already draftable. The stuck rows are the ones missing a verified path or
  channel.

## Open / not done

- `raw → verified` relies on counts the agent reports itself in
  `complete_claude_playlist_station` (`raw_discoveries`, `verified_targets`). There is no
  server-side raw-discovery log. If those counts are unreliable, the fix is a server-side
  counter in `submit_playlist_candidates`, which needs a new table and migration.
- Route-only rows are stored with `platform = 'spotify'` (unchanged default) even though
  their platform is unknown.
- Existing stranded batches (e.g. `c45d79ab`) need one `advance_playlist_batches` call
  after redeploy. There is no automatic backfill.
