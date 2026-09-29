/**
 * Discovery targeting (2026-09-27): coherent units, remaining per-song need, submissions
 * counted only with evidence, and explicit shortfalls.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { allocateDiscovery, buildPerSongFunnel, computeRemainingNeed } from "./playlist-funnel.ts";
import { buildDiscoveryCapacityPlan, measureRawToVerifiedFromLog, funnelWindow } from "./discovery-capacity.ts";

type Row = Record<string, unknown>;

function stubSb(tables: Record<string, Row[]>, failTables: Record<string, string> = {}) {
  // deno-lint-ignore no-explicit-any
  const sb: any = {
    from(table: string) {
      const filters: [string, unknown][] = [];
      const result = () => {
        if (failTables[table]) return { data: null, error: { message: failTables[table] } };
        const rows = (tables[table] ?? []).filter((r) =>
          filters.every(([k, v]) => Array.isArray(v) ? v.map(String).includes(String(r[k])) : String(r[k]) === String(v))
        );
        return { data: rows, error: null };
      };
      // deno-lint-ignore no-explicit-any
      const chain: any = {
        select: () => chain,
        eq: (k: string, v: unknown) => (filters.push([k, v]), chain),
        in: (k: string, v: unknown[]) => (filters.push([k, v]), chain),
        gte: () => chain,
        lte: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: () => Promise.resolve({ data: result().data?.[0] ?? null, error: result().error }),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(resolve(result())),
      };
      return chain;
    },
  };
  return sb;
}

const NOW = new Date("2026-09-27T20:00:00Z"); // 15:00 CT, business date 2026-09-27
const TODAY_TS = "2026-09-27T16:00:00Z";
const YESTERDAY_TS = "2026-09-26T16:00:00Z";
const DFM = "5d09da7e-98cf-4276-8dca-861d1fbbfa98";
const MED = "506ad12f-9e2e-450c-b2e9-f3d10670c015";

Deno.test("targets: coherent units — 5.6% yield needs ~1,072 raw for 60 eligible; 180 raw yields ~10", () => {
  const two = computeRemainingNeed({ objective: 60, submissionsToday: 0, approvedNotSubmitted: 0, awaitingReviewToday: 0, rawToEligibleRate: 0.056 });
  assertEquals(two.rawNeeded, 1072);
  assertEquals(Math.floor(180 * 0.056), 10);
  const perSong = computeRemainingNeed({ objective: 30, submissionsToday: 0, approvedNotSubmitted: 0, awaitingReviewToday: 0, rawToEligibleRate: 0.056 });
  assertEquals(perSong.rawNeeded, 536);
});

Deno.test("targets: remaining need subtracts real submissions and in-flight packets, never drafts as submissions", () => {
  const n = computeRemainingNeed({ objective: 30, submissionsToday: 4, approvedNotSubmitted: 3, awaitingReviewToday: 20, rawToEligibleRate: 0.1 });
  assertEquals(n.shortfall, 26); // submissions only
  assertEquals(n.remainingPackets, 3);
  assertEquals(n.rawNeeded, 30);
  const noYield = computeRemainingNeed({ objective: 30, submissionsToday: 0, approvedNotSubmitted: 0, awaitingReviewToday: 0, rawToEligibleRate: null });
  assertEquals(noYield.rawNeeded, null);
  assertEquals(noYield.basis, "no_yield_measurement");
  const zero = computeRemainingNeed({ objective: 30, submissionsToday: 0, approvedNotSubmitted: 0, awaitingReviewToday: 0, rawToEligibleRate: 0 });
  assertEquals(zero.basis, "measured_zero_yield");
});

Deno.test("funnel: separates discovery, packets, approvals and evidenced submissions per song", async () => {
  const sb = stubSb({
    agh_playlist_candidate_evaluations: [
      { track_id: DFM, business_date_ct: "2026-09-27", outcome: "verified_eligible_new", created_target: true },
      { track_id: DFM, business_date_ct: "2026-09-27", outcome: "verified_eligible_existing", created_target: false },
      { track_id: DFM, business_date_ct: "2026-09-27", outcome: "duplicate", created_target: false },
      { track_id: DFM, business_date_ct: "2026-09-27", outcome: "rejected", created_target: false },
      { track_id: MED, business_date_ct: "2026-09-27", outcome: "verified_eligible_existing", created_target: false },
    ],
    agh_handoff_records: [
      { id: "a", track_id: DFM, queue_state: "AWAITING_GROK_REVIEW", created_at: TODAY_TS, packet: {} },
      { id: "b", track_id: DFM, queue_state: "AWAITING_GROK_REVIEW", created_at: YESTERDAY_TS, packet: {} },
      { id: "c", track_id: DFM, queue_state: "CLAUDE_BATCH_READY", created_at: YESTERDAY_TS, packet: { route_hold: { code: "missing_form_url" } } },
      { id: "d", track_id: DFM, queue_state: "GROK_REVIEWED", created_at: YESTERDAY_TS, packet: {} },
      { id: "e", track_id: DFM, queue_state: "APPROVED_FOR_SEND", created_at: YESTERDAY_TS, packet: {} },
      { id: "f", track_id: DFM, queue_state: "APPROVED_FOR_SEND", created_at: YESTERDAY_TS, submitted_at: TODAY_TS, packet: {} },
      { id: "g", track_id: DFM, queue_state: "REJECTED_BY_GROK", created_at: YESTERDAY_TS, packet: {} },
      { id: "h", track_id: MED, queue_state: "AWAITING_GROK_REVIEW", created_at: TODAY_TS, packet: {} },
    ],
    pitch_log: [
      { track_id: DFM, status: "sent", sent_at: TODAY_TS, pitched_at: TODAY_TS, resend_message_id: "re_1" },
      { track_id: DFM, status: "sent", sent_at: TODAY_TS, pitched_at: TODAY_TS, resend_message_id: null }, // no evidence
      { track_id: DFM, status: "error", pitched_at: TODAY_TS },
    ],
  });
  const res = await buildPerSongFunnel(sb, [{ track_id: DFM, title: "DFM" }, { track_id: MED, title: "Meditate" }], {
    objectivePerSong: 30,
    rawToEligibleRate: 0.05,
    now: NOW,
  });
  assertEquals(res.ok, true, JSON.stringify(res.errors));
  const dfm = res.songs.find((s) => s.track_id === DFM)!;
  assertEquals(dfm.raw_candidates_evaluated, 4);
  assertEquals(dfm.net_new_identities, 1);
  assertEquals(dfm.existing_playlists_newly_matched, 1);
  assertEquals(dfm.duplicates_skipped, 1);
  assertEquals(dfm.candidates_rejected, 1);
  assertEquals(dfm.drafts_awaiting_review, 2); // held record excluded
  assertEquals(dfm.drafts_awaiting_review_today, 1);
  assertEquals(dfm.oldest_pending_review_age_hours, 28);
  assertEquals(dfm.reviewed_not_approved, 1);
  assertEquals(dfm.approved_not_submitted, 1);
  assertEquals(dfm.submissions_email_today, 1); // only the send with a provider id
  assertEquals(dfm.submissions_manual_today, 1);
  assertEquals(dfm.submissions_today, 2);
  assertEquals(dfm.send_failures_today, 1);
  assertEquals(dfm.rejected_by_grok, 1);
  assertEquals(dfm.route_holds, 1);
  assertEquals(dfm.hold_reasons, { missing_form_url: 1 });
  assertEquals(dfm.business_target_met, false);
  assertEquals(dfm.submission_shortfall, 28);
  assertEquals(dfm.usable_inflight_packets, 4);
  assertEquals(dfm.remaining_eligible_packets_needed, 24);
  assertEquals(dfm.raw_candidates_needed, 480);
  const med = res.songs.find((s) => s.track_id === MED)!;
  assertEquals(med.submissions_today, 0);
  assertEquals(med.drafts_awaiting_review_today, 1);
});

Deno.test("funnel: query failures surface as errors, not zero submissions", async () => {
  const sb = stubSb({ agh_handoff_records: [], agh_playlist_candidate_evaluations: [] }, { pitch_log: "permission denied" });
  const res = await buildPerSongFunnel(sb, [{ track_id: DFM }], { objectivePerSong: 30, rawToEligibleRate: 0.05, now: NOW });
  assertEquals(res.ok, false);
  assert(res.errors.some((e) => e.includes("pitch_log_query_failed")));
});

Deno.test("yield: server-side candidate log is preferred and dedupes by identity; fallback is labeled", async () => {
  const w = funnelWindow(7, NOW);
  const logged = await measureRawToVerifiedFromLog(stubSb({
    agh_playlist_candidate_evaluations: [
      { outcome: "verified_eligible_new", business_date_ct: "2026-09-27" },
      { outcome: "verified_eligible_existing", business_date_ct: "2026-09-26" },
      { outcome: "duplicate", business_date_ct: "2026-09-26" },
      { outcome: "rejected", business_date_ct: "2026-09-25" },
    ],
  }), w);
  assertEquals(logged?.numerator, 2);
  assertEquals(logged?.denominator, 4);
  assertEquals(logged?.by_outcome?.duplicate, 1);
  assert(String(logged?.source).includes("server-side"));

  // Log not deployed → null → plan falls back to station runs and says so.
  assertEquals(await measureRawToVerifiedFromLog(stubSb({}, { agh_playlist_candidate_evaluations: "relation \"agh_playlist_candidate_evaluations\" does not exist" }), w), null);
  const plan = await buildDiscoveryCapacityPlan(
    stubSb({
      ops_settings: [],
      daily_ops_station_runs: [{ station_id: "playlist_tranche_final", status: "completed", raw_discoveries: 100, verified_targets: 6 }],
      playlist_targets: [],
      agh_handoff_records: [],
      outreach_drafts: [],
    }, { agh_playlist_candidate_evaluations: "relation does not exist" }),
    2,
    { now: NOW },
  );
  assert(plan.funnel.raw_to_verified.source.includes("fallback"));
  assertEquals(plan.funnel.raw_to_verified.rate, 0.06);
  assertEquals(plan.raw_research_capped, false);
});

Deno.test("allocation: one song's surplus never offsets another's shortfall (DFM 42/30 vs Meditate 13/30)", () => {
  const alloc = allocateDiscovery([
    { track_id: "dfm", title: "DFM", remaining_eligible_packets_needed: 0, raw_candidates_needed: 0, verified_eligible_packets_today: 42, objective_submissions: 30 },
    { track_id: "med", title: "Meditate", remaining_eligible_packets_needed: 17, raw_candidates_needed: 203, verified_eligible_packets_today: 13, objective_submissions: 30 },
  ]);
  assertEquals(alloc[0].track_id, "med");
  assertEquals(alloc[0].priority_rank, 1);
  assertEquals(alloc[0].share_of_remaining_need, 1);
  assertEquals(alloc[0].raw_candidates_needed, 203);
  const dfm = alloc.find((a) => a.track_id === "dfm")!;
  assertEquals(dfm.share_of_remaining_need, 0);
  assertEquals(dfm.packets_today_over_objective, 12);
});

Deno.test("inventory: deferrals and holds cannot satisfy supply; review and age do not erase supply", async () => {
  for (const [label, state, created, packet, expected] of [
    ["future deferral", "AWAITING_GROK_REVIEW", TODAY_TS, { review_defer: { retry_after: "2026-09-28T20:00:00Z" } }, 30],
    ["indefinite deferral", "AWAITING_GROK_REVIEW", TODAY_TS, { review_defer: {} }, 30],
    ["invalid deferral", "AWAITING_GROK_REVIEW", TODAY_TS, { review_defer: { retry_after: "bad" } }, 30],
    ["expired deferral", "AWAITING_GROK_REVIEW", YESTERDAY_TS, { review_defer: { retry_after: YESTERDAY_TS } }, 0],
    ["reviewed", "GROK_REVIEWED", TODAY_TS, {}, 0],
    ["older pending", "AWAITING_GROK_REVIEW", YESTERDAY_TS, {}, 0],
    ["approved hold", "APPROVED_FOR_SEND", TODAY_TS, { route_hold: { code: "missing_form_url" } }, 30],
    ["approved deferral", "APPROVED_FOR_SEND", TODAY_TS, { review_defer: { retry_after: "2026-09-28T20:00:00Z" } }, 30],
  ] as const) {
    const rows = Array.from({ length: 30 }, (_, i) => ({ id: String(i), track_id: MED, queue_state: state, created_at: created, packet }));
    const result = await buildPerSongFunnel(stubSb({ agh_handoff_records: rows }), [{ track_id: MED }], {
      objectivePerSong: 30, rawToEligibleRate: 0.1, now: NOW,
    });
    const song = result.songs[0];
    assertEquals(song.submissions_today, 0, label);
    assertEquals(song.submission_shortfall, 30, label);
    assertEquals(song.remaining_eligible_packets_needed, expected, label);
    assertEquals(song.raw_candidates_needed, expected * 10, label);
    assertEquals(song.usable_inflight_packets, 30 - expected, label);
  }
});
