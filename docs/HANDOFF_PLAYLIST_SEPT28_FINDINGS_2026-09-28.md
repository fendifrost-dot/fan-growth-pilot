# Playlist pipeline — Sept 28 findings: fit authority, record truth, actionable routes, per-song targeting

**Current handoff for both agents.** It supersedes the contradictory parts of
[HANDOFF_PLAYLIST_ROUTES_THROUGHPUT_2026-09-27.md](HANDOFF_PLAYLIST_ROUTES_THROUGHPUT_2026-09-27.md)
(its route rules and standing rules still apply).

The role split is unchanged:
- **Claude** discovers, verifies and drafts.
- **Grok** reviews, approves, sends and handles responses.

Nothing here lets Claude approve or send.

Evidence came from live, non-sending connector reads on 2026-09-28 (`get_playlist_discovery_work`,
`get_own_playlist_batches`, `get_batch_candidates`), plus the repo. Findings that come from ChatGPT's or
Grok's reports and that the repo and connector cannot confirm are marked **(reported)**.

## 0. What is live vs committed (as of this handoff)

| Change | Committed | Live? | Evidence |
|---|---|---|---|
| PR #38: capacity metric, `advance_playlist_batches`, `get_batch_candidates` | main `7fc9365` | **Yes** | Live tools list includes both tools |
| PR #39: raw research cap removed | main `235f675` | **No** | Live `daily_target` still returns `research_budget_raw_total: 180` and `effective_raw_target: 180` |
| PR #40: route rules, route holds, candidate log, per-song funnel, key aliases, Grok paging | main `c4951ea` | **No** | Live `get_playlist_discovery_work` has no `per_song_funnel` |
| SQL `20260927120000_route_hold_and_candidate_log.sql` | main | **Unknown / not yet reported** | No report back from the SQL handoff yet |
| This change (`20260928120000_record_review_and_fit_requeue.sql` + code) | this PR | No | Deploy per §7 |

So **today's 55 route-bearing drafts were validated by the old (pre-#40) route rules.** They do not show
that the route defect is fixed.

## 1. Song fit: one authority

**Root cause.**
- Discovery reads `allowed_lanes` straight from the song's current approved Song DNA. For Meditate
  (DNA `f41cfb94`), `approved_lanes` is `rap_general`, `rap_trap_hype`, `rap_conscious` and
  `west_coast_conscious`, and `primary_genre` is `hip_hop_rap`.
- Grok's rejection text, "DNA_LANE_MISMATCH Meditate hip_hop_rap only", compares a playlist **lane** with
  the song's broad **primary_genre** stamp.
- `hip_hop_rap` is a genre family (`GENRE_STAMPS = hip_hop_rap | house_electronic | unknown`), not a lane.
  No lane is named `hip_hop_rap`.
- The string `DNA_LANE_MISMATCH` appears nowhere in this repo. The rule comes from Grok's own
  instructions or memory, not server code.
- Grok's read path (`get_handoff_batch`) never showed the server's fit decision, so Grok had nothing
  authoritative to compare against.

**Fix.**
- **The decision function.** `_shared/song-fit.ts` holds `decideLaneFit(approvedDna, lane)`:
  - It is policy `song_fit.v1-2026-09-28`.
  - Lane ∈ `approved_lanes` and ∉ `excluded_lanes` gives fit.
  - It returns the code, the reason, the DNA version, the policy version, and a `primary_genre_note`
    that says the genre is not a lane.
- **Every boundary uses it:**
  - `evaluateOutreachDecision` (discovery, verification, inventory, approval, send) now makes its lane
    decision through this function, with the same codes (`dna_excluded_lane`, `dna_lane_not_approved`).
  - Inventory stamps `packet.song_fit` on every new record.
  - `get_handoff_batch` (Grok) and `get_batch_candidates` (Claude) show each record's live `song_fit`
    against the song's **current** approved DNA.
  - Grok reviews: `review_handoff_records` and `review_handoff_batch`.
- **Refusing contradictory rejections.** A rejection that cites a DNA/lane mismatch is refused with
  `fit_decision_conflict` when the record's lane **is** approved.
  - Grok can still reject for any other reason: `LOW_REACH`, `LANGUAGE_MISMATCH`, `PLAYLIST_QUALITY`,
    route problems, and so on.
  - Fit stays song-specific: DFM excludes `rap_trap_hype`, `rap_conscious` and `west_coast_conscious`.
    Nothing widens a song's lanes, and discovery is not narrowed to `rap_general`.
- **Re-evaluating the "15 Meditate records" (reported).** `agh_fit_rejection_requeue(false)` previews
  them and `(true)` applies. It requeues only records that meet all of these:
  - rejected for a fit reason;
  - current-DNA lane approved;
  - the same DNA version as the draft;
  - route passes;
  - curator email not suppressed;
  - not sent;
  - no other open packet for the pair.

  Requeued records go to a new `AWAITING_GROK_REVIEW` batch (`payload.fit_requeue`). Their prior
  rejection is kept in `packet.review_history`. Nothing is approved or sent.

## 2. Record status is authoritative

**Root cause (confirmed in code).**
1. `HANDOFF_TRANSITIONS` allows only `AWAITING_GROK_REVIEW → GROK_REVIEWED`. `REJECTED_BY_GROK` is
   reachable only from `GROK_REVIEWED`. A Grok batch reject straight from awaiting review returned
   `illegal_transition`, so **the rejection never persisted**.
2. There was **no record-level review action**. `advance_agh_handoff_batch` overwrote **every** record in
   the batch with the batch state.

So a batch showing `AWAITING_GROK_REVIEW` while "30 of 31 records are rejected" (`4232637e`, **reported**)
cannot have come from server writes. The rejections most likely exist only in Grok's own log.
`4232637e` is not among Claude's 40 newest batches. `agh_handoff_state_audit` will say whether any record
rejections exist in the DB (§7).

**Fix.**
- **`review_handoff_records` (Grok / Fendi only).** It takes a decision per record:
  - `reviewed`, `reject` (with one or more `reason_codes`) or `defer` (with `retry_after`; the record
    stays in review).
  - The batch state is then derived: all records rejected → `REJECTED_BY_GROK`; nothing awaiting and
    some reviewed → `GROK_REVIEWED`. A batch never moves backwards.
- **`review_handoff_batch`.** A batch reject from `AWAITING_GROK_REVIEW` now runs reviewed → rejected, so
  it persists.
- **`advance_agh_handoff_batch`.** It no longer sweeps records already `REJECTED_BY_GROK`, and it copies a
  batch rejection reason onto each record it rejects.
- **Record-state summaries.** `list_handoff_batches`, `get_handoff_batch`, `get_own_playlist_batches` and
  `get_batch_candidates` all return `batch_status`:
  - `record_counts`, `actionable_records`, `rejected_records`
  - `mixed` and a one-line summary

  Both agents therefore read record truth instead of the batch label.
- **84 rejected vs 89 reasons (reported).** A record can carry several reason codes.
  `agh_handoff_state_audit` reports `distinct_rejected_records` and `reason_occurrences` separately, plus
  `records_with_multiple_reason_codes`.
- **The 196 / 84 / 4 / 108 audit (reported)** can't be reproduced from the Claude read path. Claude's 40
  newest batches hold 159 records, all in `AWAITING_GROK_REVIEW` batches. `agh_handoff_state_audit` splits
  every state by song into `created_today` and `created_before_today`, which answers whether the 108
  include today's records.

## 3. Actionable routes

**Separated states.** `route_actionability` on each record (Grok and Claude read paths) reports a `stage`:
- `no_route`
- `route_present_unverified`
- `route_verified_action_pending`
- `submitted_with_evidence`

It also reports:
- `manual_action_required` (web form or IG: always, since automated submit is off);
- `login_required` (`null` = unknown);
- `terms`, and `terms_confirmed` (`unknown` is never assumed free);
- `submission_completed` and `submission_evidence`: a manual `submitted_at`, or an email provider message
  id on `pitch_log`.

A drafted email, or an IG or form packet, is **not** a submission. A Soundplate page with a Spotify ID
establishes identity plus a candidate route. Its terms stay `unknown` unless the page states them.

**Why curator name, followers, verified_by and last_verified_at were empty or 0:**
- `submit_playlist_candidates` had no fields for curator name, follower count, terms or login. The insert
  never wrote them, so `follower_count` fell back to its column default `0`.
- `last_verified_at` was only written on manual re-verify.
- Record `verified_by` is never stamped by the handoff RPCs.

Now:
- Candidates may pass `curator_name`, `follower_count`, `submission_terms` and `login_required`. These
  should be **only** values read off the source.
- Unknown values are stored as `null` / `unknown`, never `0` or invented.
- `last_verified_at` is set when the route verifies, and `research_context.route_verified_by =
  "server_route_rules"` records what verified it.
- Each packet gets `route_verification` (method, the submitter, status and terms).
- Existing rows keep `0`, and read paths show `follower_count: null` when it is 0.

**Retry/defer, not reject.** `submit_playlist_candidates` returns a new `deferred` list, logged with
outcome `deferred`, for:
- song–playlist pair cooldowns (`pair_cooldown`, with `retry_after`);
- a temporary MX/DNS lookup failure (`temporary_host_failure`). A resolver error is now `lookup_failed`,
  not "no MX". No unverified row is stored, so resubmitting re-checks.
- transient DB errors while classifying an existing target (`temporary_db_error`).

**Bounce suppression (Team Specific).**
- The resend webhook stamps bounces only on the rows that hold the address at bounce time.
- A playlist row created later for the same address starts clean. It could have been retried through a
  different playlist association.
- `checkTargetSubmissionReady` (used at approval, manual submit and send) now refuses any email whose
  address hard-bounced or complained on **any** row, with code `curator_email_suppressed`.
- The fit requeue applies the same check.

## 4. Per-song targeting

- **Allocation.** `per_song_funnel.discovery_allocation` ranks songs by their own remaining need. DFM
  at 42/30 drafts (12 over) gives Meditate at 13/30 nothing: Meditate gets `share_of_remaining_need` 1 and
  DFM gets 0.
- **Metric names.** `submit_playlist_candidates` now returns `candidates_submitted_for_verification`.
  The run report's "65 submissions" was this intake count, not playlist submissions. Actual submissions
  are only `per_song_funnel.submissions_today` (email with a provider id, or a manual `submitted_at`).
- **`effective_raw_target = 180`** is the research budget PR #39 removed. It is still live only because
  the functions were not redeployed. After redeploy, `effective_raw_target = daily_raw_requirement`: the
  measured estimate (715 today at 8.4% raw→verified), with no cap. When the candidate log is on, the
  estimate is based on server-logged candidates rather than self-reported station counts.

## 5. Today's batches (Claude read path, 2026-09-28)

| Batch | Song | Records | Batch state | Record states |
|---|---|---|---|---|
| `61253677-2a8d-462d-93bd-0a75a704349d` | DFM | **28** (reported 29; `record_count` read 29 earlier today) | AWAITING_GROK_REVIEW | 28 × AWAITING_GROK_REVIEW; lane 28 × rap_general; channels: 21 web_form, 4 IG, 3 email |
| `ec562aeb-37b7-4553-9549-4d0b513a233e` | Meditate | 13 | AWAITING_GROK_REVIEW | 13 × AWAITING_GROK_REVIEW; lanes 12 × rap_general, 1 × rap_trap_hype |
| `7ec32f26-7bac-4cba-b6c4-e9ff1c7192fe` | DFM | 13 | AWAITING_GROK_REVIEW | 13 × AWAITING_GROK_REVIEW; lanes 12 × rap_general, 1 × house_general; all web_form |

All three were created directly in `AWAITING_GROK_REVIEW`, so no promotion was needed. None has a
rejection or a reviewer yet.

Across all 54 records:
- the route check passes under the pre-#40 rules;
- curator name, follower count, `verified_by` and `last_verified_at` are empty (the evidence text names
  them), as explained in §3;
- terms are `unknown`.

Further findings:
- **Record count.** `61253677` holds 28 records against the reported 29. The SQL state audit should
  confirm whether a record was moved or removed.
- **Curator cooldown.** DFM packet `77ZVb41CgYeegD5n3hJngg` in `61253677` reaches a curator that was
  already contacted for DFM through `kolibrimusic.com/submit-music-playlists/` on 2026-09-11. The
  cooldown runs until 2026-12-10. Once PR #40 is live, the manual-submit boundary blocks it. Grok should
  reject or defer it.
- **Shared curators.** Three `61253677` records share a curator route with other playlists.
  `get_batch_candidates.curator_contact` lists them.

Grok's view is `get_handoff_batch`, which is unscoped for Grok. That read path isn't reachable from Claude's
connector. Verify it with `agh_handoff_state_audit(array[...])` in §7.

**Open backlog:** at least 159 records, all in `AWAITING_GROK_REVIEW` batches.
- DFM: 100 records in 22 batches.
- Meditate: 59 records in 18 batches.
- There may be more beyond Claude's 40 newest batches.

## 6. Standing rules for both agents (replace older, contradictory rules)

**Grok:**
1. **Fit.** Judge fit by `song_fit` on each record: the lane against that song's current approved Song
   DNA. `primary_genre` (e.g. `hip_hop_rap`) is a genre family, not a lane. Never reject a lane the
   song's DNA approves as a "DNA/lane mismatch". If you think the DNA itself is wrong, raise it with
   Fendi.
2. **Deciding.** Decide per record with `review_handoff_records`:
   - `reviewed`, `reject` (use specific `reason_codes`), or `defer` (host down, cooldown, needs a
     re-check);
   - do not keep rejections only in your own notes.
3. **Batch state.** Read `batch_status.record_counts`, not the batch `queue_state`. A mixed batch still
   has actionable records.
4. **Counting.** A submission counts only with evidence: an email provider id, or a manual
   `submitted_at`. Drafts, packets, reviews and approvals are not submissions. Check
   `route_actionability.terms` before submitting, and treat `unknown` as unconfirmed.

**Claude:**
1. **Candidate fields.** Pass `curator_name`, `follower_count`, `submission_terms` and `login_required`
   only when you read them off the source. Otherwise omit them. Never estimate.
2. **Allocation.** Follow `per_song_funnel.discovery_allocation`: spend research on the song with the
   largest remaining need. One song's surplus doesn't count for another.
3. **Reporting.** Report `candidates_submitted_for_verification` as intake, never as submissions.
4. **Deferred candidates.** Resubmit `deferred` candidates later. They are not rejections.

## 7. Deploy (Lovable only) and verification

1. **SQL Editor, in order:**
   - `20260927120000_route_hold_and_candidate_log.sql` (if not already applied);
   - `20260928120000_record_review_and_fit_requeue.sql`.

   The browser-agent steps are in
   [HANDOFF_SQL_APPLY_ROUTE_HOLD_2026-09-28.md](HANDOFF_SQL_APPLY_ROUTE_HOLD_2026-09-28.md).
2. **Redeploy the edge functions:**
   - `mcp-playlist-discovery`, `control-center-api`, `execute-pitch`, `send-pitch-email`, `approve-draft`
   - `draft-pitch`, `playlist-admin-api`, `playlist-research`, `enrich-curator-contacts`,
     `schedule-follow-up`, `mcp-sync-discovery`
3. **Refresh the Claude connector** so it picks up the new candidate fields and the `deferred` outcome.
   Give Grok the §6 rules.
4. **Non-sending checks:**
   - `get_playlist_discovery_work` shows `per_song_funnel.discovery_allocation` and no
     `research_budget_raw_total`;
   - `get_batch_candidates` shows `song_fit`, `route_actionability` and `batch_status`;
   - `select public.agh_handoff_state_audit();`
   - `select public.agh_fit_rejection_requeue(false);` (preview), then `(true)` only if the preview
     matches expectations.

**Not changed:**
- Grok's approval and sending ownership.
- The route rules from 09-27.
- Direct creation in `AWAITING_GROK_REVIEW`, cross-day `advance_playlist_batches`, and `get_batch_candidates`.
