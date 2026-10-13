# HANDOFF — AGH queue reconciliation + re-verify pagination (2026-10-13)

Status: **CODED, not LIVE.** The code change in this branch does nothing until the
`mcp-playlist-discovery` edge function is redeployed in **Lovable → Edge Functions**.
Nothing below is verified live until someone runs the checks in §3 and pastes the output.

## 1. What was found (read-only, live FanFuel Hub DB, 2026-10-13 ~14:00 UTC)

The run that reported "418 pending / 41 approved-unsent / 665 rejections" was
Claude's own `playlist_tranche_first` run `b2acdce4-4738-4aa8-97fe-181b149a5927`, not a Grok report.
Grok's 10-13 SOD (`muse_daily_reports` 30219880…) carries no playlist counts.

| Reported | Live now | What the number actually is |
|---|---|---|
| 418 pending review | 408 (`drafts_awaiting_review` 189 + 219) = 393 `AWAITING_GROK_REVIEW` + 15 `CLAUDE_BATCH_READY` with released route holds | **Lifetime, no age/dedupe filter** (`playlist-funnel.ts` `pending`). Of the 393: **261 Soundplate (frozen route)**, **41 re-drafts of pairs Grok already rejected on the same route** (login_only, paywall, pay-to-play, captcha…), 13 `review_defer`, 1 `plc_hold`, **77 reviewable**. The 15 released-hold records sit in 5 route-repair batches that also hold still-held records, so `advance_playlist_batches` skips them (`route_hold_unresolved`). |
| 41 approved-unsent | 35 `APPROVED_FOR_SEND` (MED 22 / DFM 13) | 23 IG DMs with approved drafts, no receipt · **7 IG records whose drafts PLC rejected 10-13 13:29Z (dead handles) but whose handoff state is still `APPROVED_FOR_SEND`** · 2 IG approved today with **no outreach draft** · 2 email approved today whose drafts are still `pending` · 1 web form (sbmt.to/airbender) |
| 665 rejections | 670 `REJECTED_BY_GROK` | **Lifetime total** since 09-09, not a backlog. |

Of the 77 reviewable, 22 are on hosts with 0 lifetime approvals and a standing CoS freeze
(submitlink.io 19, dailyplaylists.com 2, submithub.com 1). **Genuinely reviewable: ~55.**
Oldest reviewable: MED `c538bf4a…` (IG, 2026-09-13); DFM `34295b47…` (submitlink.io, 09-14 — frozen host, so the
oldest *unfrozen* DFM item is from 10-07).

**Last 7 days** (to 10-13 ~14:00Z). The reviewed, approved and rejected columns use `updated_at`, so they are approximate:

| Song | Incoming | Reviewed | Approved | Rejected | Confirmed sends (`pitch_log`) |
|---|---|---|---|---|---|
| Meditate | 81 | 40 | 38 | 9 | 25 |
| Designed For Me | 75 | 18 | 15 | 8 | 16 |

**Discovery headroom 0** is correct per the formula `max(0, 30 − submissions_today − usable_inflight)`.
But `usable_inflight` (39 per song) counts never-reviewed packets of any age. That includes the
41 re-drafts of rejected pairs and the frozen-host packets. The "no need" signal is
therefore partly phantom supply. **Not changed:** the any-age rule is deliberate and tested
(`playlist-funnel.test.ts:183`), so changing it is a decision for Fendi or Cursor (see §4).

**Raw target 101 vs 1,200:** 101 = ceil(60 / 0.5966), measured from
`agh_playlist_candidate_evaluations` (n=352, 7d). 1,200 was the `no_data` fallback
(ceil(60 / 0.05)). The replacement is correct. Caveat: that log query is not paginated, so
once more than 1,000 evaluations fall in 7 days it will sample an arbitrary 1,000.

## 2. Code change in this branch

`get_playlist_discovery_work` re-verify queue was hard-capped at 25 rows with no way to
page (`needsReverify.slice(0, 25)`, schema `properties: {}`). The 54 rows reported as
"unreachable" exist: the live DB has **80 scanned / 79 needing re-verify** (DFM-lane 58,
Meditate-lane 15, 1 null lane, 1 with no route field).

- Optional `reverify_offset` (0–10000) and `reverify_limit` (1–100, default 25).
- Stable `order("playlist_id")`, scan limit 1000, plus `scan_limit_reached`.
- Response adds `reverify_offset`, `reverify_limit`, `returned`, `next_reverify_offset` (null on the last page).
- Unknown args are still rejected (`additionalProperties: false`).
- Tests: `re-verify queue pages past the first 25 rows` and `re-verify paging args are validated`.
  Both **failed on the old code and pass on the new**. Full `_shared` suite: 569 passed, 0 failed (deno 2.5.6).

## 3. To make it live, then verify

1. Merge the PR to `main`.
2. **Lovable → Edge Functions → redeploy `mcp-playlist-discovery`.** Publish is not enough; no SQL is needed.
3. Verify through the AGH Playlist Discovery MCP connector:
   - `get_playlist_discovery_work {"reverify_offset": 25}`. **Expect** `manually_verified_supply.reverify_offset = 25`,
     `returned = 25`, `next_reverify_offset = 50`, `needs_reverify_count ≈ 79` (it can drift as rows are re-verified).
   - **Not deployed** looks like HTTP 400 with `code: "invalid_args"` or a response without `next_reverify_offset`.
   - Follow `next_reverify_offset` until it is `null`. The distinct `playlist_id`s across pages must equal `needs_reverify_count`.
     If they don't, the scan is unstable: report that and don't paper over it.

Do **not** edit this change to "make it pass" against live data. A mismatch is the finding.

## 4. Open items — not executed here, with owners

| Item | Owner | Why it is not done here |
|---|---|---|
| 7 dead-handle IG records still `APPROVED_FOR_SEND` while their drafts are `rejected` | PLC (grok_playlist_control) | A review-state change belongs to Grok; Claude's tools cannot reject records. Until fixed they inflate approved-unsent by 7. |
| 23 approved IG DMs with no receipt. Enki said on 10-12 that 8 of 28 were skipped, which implies up to 20 were sent unlogged. | Enki (sender) → PLC (logs via mark_manual_ig_dm_submitted) | **Do not re-send.** Grok asked for receipts 10-13 13:31Z. The daily 9:28 pack re-lists anything still `APPROVED_FOR_SEND`, so a duplicate-DM risk stays open until the receipts are logged. |
| 2 email records approved, drafts still `pending` | PLC (approve_draft) / send path | The handoff state and the draft gate disagree, so the email sender will not pick them up. |
| 2 IG records approved with no outreach draft (Your_Own_Music, Bradzbaby) | PLC (IG copy) | There is no copy to send. |
| 1 web form approved (sbmt.to/airbender) | PLC manual-submit lane | Needs a manual submission and a receipt. |
| 261 Soundplate records sit in the review queue | Fendi decision | The route is frozen, so they can never send. Ask whether to keep, hold, or exclude them from `drafts_awaiting_review`. |
| 41 re-drafts of already-rejected pairs (same route, structural codes) | Cursor (code) + Fendi | Intake re-accepts a pair whose earlier record was rejected for login, paywall or pay-to-play. It is not a fit requeue. |
| 15 released-hold records stuck in mixed route-repair batches | Cursor (code) | `advance` is all-or-nothing per batch. |
| `usable_inflight` counts any-age, never-reviewed packets as supply | Fendi decision | It is a deliberate rule, so changing it is a scope decision. |
| Routine prompts still say `effective_raw_target` is 1200 and read three files that don't exist | Fendi (routine owner) | See §5. |

## 5. Missing standing-rules files

The 7:00a routine (`trig_01J6qVNwPng9L53cQ8p6PNcL`) opens with "READ FIRST":
`agh-playlist-supply-blockers.md`, `agh-playlist-run-log.md`, `claude-operating-lane.md`.

None of the three exists in any repo, Drive, or Gmail reachable from a cloud run. The rules are carried in
Claude memory entries (`agh-amendment-*`, `agh-playlist-run-log-*`), which a cloud session cannot read.

The nearest version-controlled source is:
- `docs/HANDOFF_PLAYLIST_ROUTES_THROUGHPUT_2026-09-27.md` §4
- `docs/HANDOFF_PLAYLIST_SEPT28_FINDINGS_2026-09-28.md` §6

The routine prompt also contradicts §4: it still calls cross-day promotion "disproven", although `advance_playlist_batches`
works for any business date. Nobody has invented the missing rules. Fendi should either commit the three files (for example
under `docs/agh-rules/`) or point the routine at the §4/§6 docs.

**Unattended limitation:** in scheduled runs, WebFetch on curator domains that are not allowlisted (e.g.
musicto.com) asks for a permission click that nobody answers, so the request is withdrawn
(`PROVENANCE_REQUIRED`). That caps first-party route verification. The fix is to pre-approve
the curator domain set or run that station attended, not to bypass the gate.

## 6. Report back

Paste: the PR merge SHA, the redeploy time, and the raw `manually_verified_supply` block from
`reverify_offset: 25` and from the last page.
