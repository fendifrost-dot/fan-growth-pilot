# Playlist route correctness, throughput, ID repair, Grok handoff — 2026-09-27

> **Continued by [HANDOFF_PLAYLIST_SEPT28_FINDINGS_2026-09-28.md](HANDOFF_PLAYLIST_SEPT28_FINDINGS_2026-09-28.md).**
> That doc covers:
> - one song-fit authority;
> - record-level review, where record state is authoritative;
> - route actionability and deferrals;
> - per-song allocation.
>
> Its standing rules (§6) add to the ones below.

Owner: Claude Code (Cursor unavailable). The role split is unchanged:
- **Claude** discovers, verifies, drafts and did these engineering repairs.
- **Grok** reviews, gives final approval, sends and handles responses.
- Nothing in this change lets Claude approve or send.

Evidence came from live connector reads on 2026-09-27: batch `2ec6577b-ad74-487f-a5c1-322043b3e205`, the four
2026-09-27 batches, and `get_own_playlist_batches`. `agh-amendment-6` and `agh-playlist-run-log-9` were not in
the repo or Drive, so the code and live data were the sources.

## 1. Confirmed root causes

| Defect | Cause |
|---|---|
| **Packets with no route / a Spotify URL as form marked `auto_verified`** (`2ec6577b`: 7 null routes, 1 Spotify URL, 3 valid) | **(1)** `submit_playlist_candidates` passed `submission_url: form_url \|\| playlistUrl`, so every candidate carried its own Spotify URL. **(2)** `evaluateSubmissionPath` inferred `web_form` from that URL and accepted any http URL with any non-empty evidence, including "no submission route confirmed". **(3)** No approval or send boundary re-checked the route. |
| **Generic homepage used as another curator's form** (`af913aa5`: 4 records) | Evidence ("surfaced in a search for rap playlists accepting free submissions") never tied the playlist to `dailyplaylists.com/`. |
| **`spotify:` IDs → `target_classification_unverified`** | **(1)** Catalog row stored as `spotify:<id>`, a legitimate key form also used by placements and `pitch_log`. **(2)** Discovery normalized it to `<id>`, the lookup missed, and a new unverified row was inserted. **(3)** The DNA envelope rejected that new row (`target_classification_unverified`), so manual re-verify never ran. |
| **effective_raw_target 180** | A research budget capped raw passes. It was removed in PR #39 (commit 235f675), and 180 was the pre-#39 number. |
| **5.6% yield** | Numerator and denominator are agent self-reports (`daily_ops_station_runs.raw_discoveries/verified_targets`). "Raw" was undefined, and retries and cross-song reuse were not deduped. |
| **Grok backlog visibility** | `list_handoff_batches` returns newest-first, limit 40, no total. The live AWAITING_GROK_REVIEW backlog already exceeds the latest 40 batches, and none of those 40 has moved past review. |

## 2. What changed

**Routes (P1).**
- **Shared rules** in `_shared/submission-route.ts`, with an SQL mirror `agh_route_failure_code`:
  - Route verification is separate from identity and song fit.
  - A web form must:
    - be a non-platform page (never Spotify, Apple Music, Deezer, Tidal or YouTube Music);
    - not be the playlist's own URL;
    - have evidence that does not say "no route confirmed";
    - have evidence (or its listing page) that names the form's site. Hosted form builders are identified by URL.
  - Email needs a verified status and a valid address.
  - `is_active=false` is never submission-ready.
  - Unknown free/paid terms stay `unknown` and are surfaced as `submission_terms`.
- **Re-checks at every boundary:**
  - discovery verification and inventory creation;
  - existing-target classification;
  - Grok review/approve;
  - manual form/IG submission;
  - `approve_draft`, `execute-pitch`, `send-pitch-email`.
- **Holds:** failing records move into a Claude-side **repair batch** (`CLAUDE_BATCH_READY`, `payload.route_hold_repair`). The history is kept in `packet.route_hold` / `route_hold_history` and in the batch notes. Valid records in the same batch keep moving. Approval fails closed if the hold RPC is missing.
- **Release:** a successful re-verify releases the hold and refreshes the packet. `advance_playlist_batches` then sends the repair batch back to Grok. Repair batches with unresolved holds cannot be advanced.

**Throughput (P2).**
- **Units:**
  - raw unit = a distinct song–playlist candidate per CT day;
  - the business goal = **actual submissions** per song (30);
  - drafts, reviews and approvals are never counted as submissions.
- **Server-side yield:** `submit_playlist_candidates` logs every candidate outcome to `agh_playlist_candidate_evaluations`. Retries collapse and the best outcome is kept. The yield uses this log, and the station-run fallback is labelled as self-reported.
- **Per-song funnel** in `get_playlist_discovery_work.per_song_funnel`, with separate counts for:
  - net-new identities and existing playlists newly matched;
  - eligible packets, awaiting review (with oldest age), reviewed, and approved-not-submitted;
  - evidenced submissions (email with a provider ID, or manual `submitted_at`), failures, rejections and holds;
  - remaining need, and `raw_candidates_needed` computed from the measured yield.
- **Station completion** returns `business_target` separately from the station status, and warns when the target is unmet and no `shortfall_reason` was given.

**Spotify IDs (P3).**
- `parseSpotifyPlaylistId` accepts a bare ID, `spotify:ID`, `spotify:playlist:ID`, `spotify:user:…:playlist:ID`, and `open.spotify.com` URLs (including `intl-xx` and `embed`). Track, album and artist links fail with `wrong_entity_type`.
- Lookups resolve all stored key forms. **Rows are not renamed**, because `spotify:<id>` is a legitimate key referenced by `pitch_log`.
- Two stored forms for one playlist are reported as `identity_alias_collision` and never merged.
- `agh_spotify_key_alias_report()` (read-only) gives the prefixed-row count and lists collisions.
- Normalization never grants route, fit or approval.

**Cross-song reuse and curator contact (P4).**
- Each receiving song passes its own DNA envelope; `rap_general` is only a hint.
- Playlists that share a curator (same email, form or IG) are detected.
- The existing per-song rule (one pitch per song per `artist_config.cooldown_days`, default 90) now applies at curator level, at manual submission and at email send.
- Contacts for other songs are reported only; no new cooldown is added.
- `get_batch_candidates` exposes `curator_contact`, `route_check`, `route_hold` and `submission_terms`.

**Grok handoff (P5).**
- `list_handoff_batches` gains `order: "oldest_first"`, `offset`, `total_count` and `has_more`.
- New `playlist_pipeline_report` (Grok, Fendi and admin see everything; Claude sees its own batches) reports:
  - review backlog and the oldest pending age;
  - reviewed vs approved vs submitted, as separate counts;
  - rejection reasons, holds by code and repair batches;
  - a **stranded Claude-batch check**.

## 3. Deploy (Lovable only)

1. **SQL Editor:** paste `supabase/migrations/20260927120000_route_hold_and_candidate_log.sql`. It is idempotent and defines functions and a table only.
2. **Redeploy these 11 edge functions.** They were found with `deno info` over the changed shared files:
   - `mcp-playlist-discovery`, `control-center-api`, `execute-pitch`, `send-pitch-email`, `approve-draft`
   - `draft-pitch`, `playlist-admin-api`, `playlist-research`, `enrich-curator-contacts`, `schedule-follow-up`
   - `mcp-sync-discovery`
3. **Audit, preview first:**
   ```sql
   select public.agh_route_hold_audit(false);   -- counts by code + record list, no writes
   select public.agh_route_hold_audit(true);    -- moves failing unsent records to repair batches
   select public.agh_spotify_key_alias_report(); -- prefixed rows + collisions (read-only)
   ```
   The audit never touches submitted, sent, rejected or imported records.
4. **Refresh the Claude connector.** It gets new descriptions and `per_song_funnel`.
5. **Grok:** page review with `list_handoff_batches {queue_state:"AWAITING_GROK_REVIEW", order:"oldest_first"}` and read `playlist_pipeline_report`.

If step 1 is skipped:
- Grok approval of a batch containing a bad route **fails closed** (503 `migration_required`).
- The candidate log is simply off, and discovery is never blocked.

## 4. Standing rules — supersede the promotion workarounds

These replace any earlier "accumulate batches and promote the last one in the run", "one `output_batch_id` per
tranche" or "re-open the station to promote" instructions. They should be copied into the next amendment of the
Claude discovery run rules (the `agh-amendment-*` series is kept outside this repo).

1. Batches enter `AWAITING_GROK_REVIEW` when inventory is created. No station-close promotion is needed.
2. If a batch is stranded at `CLAUDE_BATCH_READY` (see `playlist_pipeline_report.stranded_claude_batches`),
   clear it with `advance_playlist_batches([...ids])`. This works for any business date.
3. A web-form route needs a real form URL and evidence that names the form's site. Never use the playlist's
   Spotify URL, and never use a site's homepage for another curator's playlist.
4. Repair batches (route holds) go back to Grok only after the target route is re-verified with fresh evidence,
   by re-submitting the candidate.
5. Report per song from `per_song_funnel`: submissions (evidenced), packets awaiting review and
   `raw_candidates_needed`. Close the station `partial` with a `shortfall_reason` when stopping short.

Historical logs are unchanged. The stranded check is retained in `playlist_pipeline_report`.
