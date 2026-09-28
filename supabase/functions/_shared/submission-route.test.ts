/**
 * Submission-route correctness (2026-09-27): identity/genre never implies a route;
 * Spotify playlist URLs are never forms; old invalid packets are blocked downstream.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  assertSubmissionReady,
  assessSubmissionRoute,
  checkTargetSubmissionReady,
  evidenceNegatesRoute,
  releaseRouteHoldsForTarget,
  routeActionability,
  submissionTerms,
} from "./submission-route.ts";
import { evaluateSubmissionPath } from "./multichannel-path.ts";
import {
  advanceClaudeReadyBatches,
  batchStatusSummary,
  markManualFormSubmitted,
  reviewHandoffBatch,
  reviewHandoffRecords,
} from "./handoff-queues.ts";
import { resolveOpsActor } from "./ops-actors.ts";
import { playlistDiscoveryActor } from "./playlist-discovery-mcp.ts";

type Row = Record<string, unknown>;

// Evidence strings copied from live batch 2ec6577b (2026-09-26).
const NO_ROUTE_EVIDENCE =
  "Spotify playlist 'Deep Groove House' by curator Chosic. Surfaced via deep-house groove curator search; no submission route confirmed at time of check.";
const CURATOR_ONLY_EVIDENCE = "Curator name OneSevenMusic shown on the Spotify playlist page.";
const DAILYPLAYLISTS_EVIDENCE =
  "DailyPlaylists free house list: Club Music 2025 (id 3tfKhtLN08PQcIH6nk6qk0, 73,487 followers, Unity Records).";

function webFormTarget(over: Row = {}): Row {
  return {
    playlist_id: "3tfKhtLN08PQcIH6nk6qk0",
    verification_status: "auto_verified",
    path_verified: true,
    contact_method: "web_form",
    submission_method: "web_form",
    form_url: "https://dailyplaylists.com/submit-song/add-song",
    form_source_evidence: DAILYPLAYLISTS_EVIDENCE,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

Deno.test("route: missing form_url cannot be submission-ready (7 null-route records in 2ec6577b)", () => {
  const t = webFormTarget({ form_url: null, submission_url: null, form_source_evidence: NO_ROUTE_EVIDENCE });
  const r = assertSubmissionReady(t, "web_form");
  assertEquals(r.ok, false);
  assertEquals(r.code, "missing_form_url");
  const curatorOnly = assertSubmissionReady(webFormTarget({ form_url: null, form_source_evidence: CURATOR_ONLY_EVIDENCE }), "web_form");
  assertEquals(curatorOnly.code, "missing_form_url");
  // Blank strings are missing too.
  assertEquals(assertSubmissionReady(webFormTarget({ form_url: "   " }), "web_form").code, "missing_form_url");
});

Deno.test("route: Spotify playlist URL used as form_url is rejected", () => {
  const url = "https://open.spotify.com/playlist/370YtLfVc3bwtUp3uhyyAO";
  const r = assertSubmissionReady(webFormTarget({ form_url: url, submission_url: url }), "web_form");
  assertEquals(r.ok, false);
  assertEquals(r.code, "spotify_url_as_form");
  // Legacy submission_url holding the playlist URL is not a form either.
  const legacy = assertSubmissionReady(webFormTarget({ form_url: null, submission_url: url }), "web_form");
  assertEquals(legacy.code, "spotify_url_as_form");
  // Other listening platforms are not forms.
  assertEquals(
    assessSubmissionRoute({ form_url: "https://music.apple.com/us/playlist/x/pl.123", form_source_evidence: "curated list" }, "web_form").code,
    "platform_url_as_form",
  );
});

Deno.test("route: a syntactically valid URL alone is not a verified form", () => {
  assertEquals(assessSubmissionRoute({ form_url: "https://curator.example/submit" }, "web_form").code, "missing_form_evidence");
  assertEquals(
    assessSubmissionRoute({ form_url: "https://curator.example/submit", form_source_evidence: NO_ROUTE_EVIDENCE }, "web_form").code,
    "evidence_negates_route",
  );
  assert(evidenceNegatesRoute("Submission route not confirmed yet"));
  assert(evidenceNegatesRoute("Curator says submissions are closed"));
  assert(!evidenceNegatesRoute(DAILYPLAYLISTS_EVIDENCE));
});

Deno.test("route: valid evidenced forms, Soundplate, email and IG still pass", () => {
  assertEquals(assertSubmissionReady(webFormTarget(), "web_form").ok, true);
  assertEquals(
    assertSubmissionReady(webFormTarget({
      form_url: "https://soundplate.com/submit-music/",
      form_source_evidence: "Soundplate playlist submission page linked from the curator profile",
    }), "web_form").ok,
    true,
  );
  assertEquals(
    assertSubmissionReady({
      verification_status: "auto_verified",
      path_verified: false, // legacy email target: deliverability comes from verifyEmail
      contact_method: "email",
      curator_email: "curator@label.example",
    }, "email").ok,
    true,
  );
  assertEquals(
    assertSubmissionReady({
      verification_status: "manually_verified",
      path_verified: true,
      contact_method: "instagram_dm",
      ig_curator_account: "@deephouse.curator",
      ig_source_evidence: "IG bio says DM for playlist submissions",
    }, "instagram_dm").ok,
    true,
  );
});

Deno.test("route: identity/genre verification never implies a route", () => {
  // A resolved Spotify identity with a good lane but no route stays not-ready.
  const r = assertSubmissionReady({
    playlist_id: "1ApnlS1I4dNX4ZKAQIyu62",
    verification_status: "auto_verified",
    path_verified: false,
    lane: "deep_house_groove",
    contact_method: "web_form",
  }, "web_form");
  assertEquals(r.ok, false);
  assertEquals(r.code, "route_not_verified");
  assertEquals(assertSubmissionReady(null, "email").code, "target_missing");
});

Deno.test("route: submission terms stay explicit; unknown is never assumed free", () => {
  assertEquals(submissionTerms({ submission_cost: "free" }), "free");
  assertEquals(submissionTerms({ submission_cost: "paid" }), "paid");
  assertEquals(submissionTerms({ submission_cost: null }), "unknown");
  assertEquals(submissionTerms({}), "unknown");
});

Deno.test("verify: the playlist's own Spotify URL no longer infers a web-form route", async () => {
  const v = await evaluateSubmissionPath({
    submission_channel: null,
    curator_email: null,
    form_url: null,
    form_source_evidence: NO_ROUTE_EVIDENCE,
    submission_url: "https://open.spotify.com/playlist/1ApnlS1I4dNX4ZKAQIyu62",
    playlist_url: "https://open.spotify.com/playlist/1ApnlS1I4dNX4ZKAQIyu62",
  });
  assertEquals(v.path_verified, false);
  assertEquals(v.code, "no_path");

  const explicit = await evaluateSubmissionPath({
    submission_channel: "web_form",
    form_url: null,
    form_source_evidence: NO_ROUTE_EVIDENCE,
    submission_url: null,
  });
  assertEquals(explicit.path_verified, false);
  assertEquals(explicit.code, "missing_form_url");

  const ok = await evaluateSubmissionPath({
    submission_channel: "web_form",
    form_url: "https://dailyplaylists.com/submit-song/add-song",
    form_source_evidence: DAILYPLAYLISTS_EVIDENCE,
  });
  assertEquals(ok.path_verified, true);
  assertEquals(ok.status, "auto_verified");
});

// ---------------------------------------------------------------------------
// Downstream boundaries (stubbed DB)
// ---------------------------------------------------------------------------

function stubSb(
  tables: Record<string, Row[]>,
  rpc: Record<string, (args: Row) => { data: unknown; error: { message: string } | null }> = {},
) {
  const writes: { table: string; op: string; row: Row }[] = [];
  // deno-lint-ignore no-explicit-any
  const sb: any = {
    _tables: tables,
    _writes: writes,
    rpc: (name: string, args: Row = {}) =>
      Promise.resolve(rpc[name] ? rpc[name](args) : { data: null, error: { message: `could not find the function ${name}` } }),
    from(table: string) {
      tables[table] ??= [];
      const filters: [string, unknown][] = [];
      let mode: "select" | "update" = "select";
      let patch: Row = {};
      const match = () =>
        tables[table].filter((r) =>
          filters.every(([k, v]) =>
            Array.isArray(v)
              ? v.map(String).includes(String(r[k]))
              : v && typeof v === "object" && "ilike" in (v as Row)
              ? String(r[k] ?? "").toLowerCase() === String((v as Row).ilike).toLowerCase()
              : String(r[k]) === String(v)
          )
        );
      // deno-lint-ignore no-explicit-any
      const chain: any = {
        select: () => chain,
        eq: (k: string, v: unknown) => (filters.push([k, v]), chain),
        in: (k: string, v: unknown[]) => (filters.push([k, v]), chain),
        ilike: (k: string, v: unknown) => (filters.push([k, { ilike: v }]), chain),
        order: () => chain,
        limit: () => chain,
        update: (p: Row) => ((mode = "update"), (patch = p), chain),
        maybeSingle: () => {
          if (mode === "update") {
            const hit = match();
            for (const r of hit) Object.assign(r, patch);
            writes.push({ table, op: "update", row: patch });
            return Promise.resolve({ data: hit[0] ?? null, error: null });
          }
          return Promise.resolve({ data: match()[0] ?? null, error: null });
        },
        then: (resolve: (v: unknown) => unknown) => {
          if (mode === "update") {
            const hit = match();
            for (const r of hit) Object.assign(r, patch);
            writes.push({ table, op: "update", row: patch });
            return Promise.resolve(resolve({ data: null, error: null, count: hit.length }));
          }
          return Promise.resolve(resolve({ data: match(), error: null }));
        },
      };
      return chain;
    },
  };
  return sb;
}

function grokActor() {
  Deno.env.set("GROK_PLAYLIST_CONTROL_SECRET", "grok-secret");
  return resolveOpsActor(
    null,
    new Request("https://example.test/", { method: "POST", headers: { "x-grok-playlist-control-secret": "grok-secret" } }),
  );
}

Deno.test("boundary: manual form submission blocks an approved packet whose route is invalid", async () => {
  const sb = stubSb({
    agh_handoff_records: [{
      id: "rec-spot",
      queue_state: "APPROVED_FOR_SEND",
      track_id: "track-a",
      playlist_target_id: "370YtLfVc3bwtUp3uhyyAO",
      submission_channel: "web_form",
      song_dna_version_id: "dna-a",
      packet: { packet_kind: "manual_web_form_packet" },
    }],
    playlist_targets: [webFormTarget({
      playlist_id: "370YtLfVc3bwtUp3uhyyAO",
      form_url: "https://open.spotify.com/playlist/370YtLfVc3bwtUp3uhyyAO",
    })],
  });
  const res = await markManualFormSubmitted(sb, { handoff_record_id: "rec-spot" }, grokActor());
  assertEquals(res.status, 422, JSON.stringify(res.data));
  assertEquals(res.data.code, "route_not_submission_ready");
  assertEquals(res.data.route_code, "spotify_url_as_form");
  assertEquals(sb._writes.length, 0);
});

Deno.test("boundary: manual submission refuses records on route hold", async () => {
  const sb = stubSb({
    agh_handoff_records: [{
      id: "rec-held",
      queue_state: "APPROVED_FOR_SEND",
      track_id: "track-a",
      playlist_target_id: "3tfKhtLN08PQcIH6nk6qk0",
      submission_channel: "web_form",
      packet: { route_hold: { code: "missing_form_url", reason: "no form" } },
    }],
    playlist_targets: [webFormTarget()],
  });
  const res = await markManualFormSubmitted(sb, { handoff_record_id: "rec-held" }, grokActor());
  assertEquals(res.status, 422);
  assertEquals(res.data.code, "route_hold");
});

Deno.test("boundary: Grok approval holds invalid records and keeps valid ones moving", async () => {
  const tables: Record<string, Row[]> = {
    agh_handoff_batches: [{ id: "batch-1", batch_kind: "playlist", queue_state: "GROK_REVIEWED" }],
    agh_handoff_records: [
      { id: "r-null", batch_id: "batch-1", record_kind: "playlist_target", queue_state: "GROK_REVIEWED", playlist_target_id: "t-null", submission_channel: "web_form", packet: {} },
      { id: "r-ok", batch_id: "batch-1", record_kind: "playlist_target", queue_state: "GROK_REVIEWED", playlist_target_id: "t-ok", submission_channel: "web_form", packet: {} },
    ],
    playlist_targets: [
      webFormTarget({ playlist_id: "t-null", form_url: null, form_source_evidence: NO_ROUTE_EVIDENCE }),
      webFormTarget({ playlist_id: "t-ok" }),
    ],
  };
  const heldCalls: Row[] = [];
  const sb = stubSb(tables, {
    agh_route_hold_records: (args) => {
      const items = args.p_items as Row[];
      heldCalls.push(...items);
      for (const it of items) {
        const rec = tables.agh_handoff_records.find((r) => r.id === it.record_id)!;
        rec.batch_id = "repair-1";
        rec.queue_state = "CLAUDE_BATCH_READY";
        rec.packet = { route_hold: { code: it.code } };
      }
      return { data: { ok: true, held: items.map((i) => ({ record_id: i.record_id, repair_batch_id: "repair-1" })) }, error: null };
    },
    advance_agh_handoff_batch: (args) => {
      const b = tables.agh_handoff_batches.find((x) => x.id === args.p_batch_id)!;
      b.queue_state = String(args.p_next_state);
      for (const r of tables.agh_handoff_records.filter((x) => x.batch_id === args.p_batch_id)) {
        r.queue_state = String(args.p_next_state);
      }
      return { data: { ok: true, batch: b, records_updated: 1 }, error: null };
    },
  });
  const res = await reviewHandoffBatch(sb, { batch_id: "batch-1", decision: "approve" }, grokActor());
  assertEquals(res.status, 200, JSON.stringify(res.data));
  assertEquals(res.data.route_held_count, 1);
  assertEquals(heldCalls.map((h) => h.record_id), ["r-null"]);
  assertEquals(heldCalls[0].code, "missing_form_url");
  const byId = new Map(tables.agh_handoff_records.map((r) => [r.id, r]));
  assertEquals(byId.get("r-ok")!.queue_state, "APPROVED_FOR_SEND");
  assertEquals(byId.get("r-null")!.queue_state, "CLAUDE_BATCH_READY");
});

Deno.test("boundary: approval fails closed when the hold RPC is not deployed", async () => {
  const tables: Record<string, Row[]> = {
    agh_handoff_batches: [{ id: "batch-2", batch_kind: "playlist", queue_state: "GROK_REVIEWED" }],
    agh_handoff_records: [
      { id: "r-spot", batch_id: "batch-2", record_kind: "playlist_target", queue_state: "GROK_REVIEWED", playlist_target_id: "t-spot", submission_channel: "web_form", packet: {} },
    ],
    playlist_targets: [webFormTarget({ playlist_id: "t-spot", form_url: "https://open.spotify.com/playlist/370YtLfVc3bwtUp3uhyyAO" })],
  };
  let advanced = false;
  const sb = stubSb(tables, {
    advance_agh_handoff_batch: () => {
      advanced = true;
      return { data: { ok: true }, error: null };
    },
  });
  const res = await reviewHandoffBatch(sb, { batch_id: "batch-2", decision: "approve" }, grokActor());
  assertEquals(res.status, 503);
  assertEquals(res.data.code, "migration_required");
  assertEquals(advanced, false);
  assertEquals(tables.agh_handoff_batches[0].queue_state, "GROK_REVIEWED");
});

Deno.test("boundary: repair batches do not go back to Grok until holds are released", async () => {
  const tables: Record<string, Row[]> = {
    agh_handoff_batches: [{ id: "repair-1", batch_kind: "playlist", queue_state: "CLAUDE_BATCH_READY", discovered_by: "claude_playlist_discovery" }],
    agh_handoff_records: [
      { id: "r-held", batch_id: "repair-1", playlist_target_id: "t-fixed", submission_channel: "web_form", packet: { route_hold: { code: "missing_form_url" } } },
    ],
    playlist_targets: [webFormTarget({ playlist_id: "t-fixed", form_url: null })],
  };
  const sb = stubSb(tables, {});
  const ops = playlistDiscoveryActor();
  const blocked = await advanceClaudeReadyBatches(sb, { batch_ids: ["repair-1"] }, ops);
  assertEquals((blocked.data.skipped as Row[])[0].reason, "route_hold_unresolved");
  assertEquals(tables.agh_handoff_batches[0].queue_state, "CLAUDE_BATCH_READY");

  // Still invalid → release keeps the hold.
  const none = await releaseRouteHoldsForTarget(sb, "t-fixed", "claude_playlist_discovery");
  assertEquals(none.released, []);
  assertEquals(none.still_held, ["r-held"]);

  // Route repaired on the target → hold released, packet refreshed, history kept.
  Object.assign(tables.playlist_targets[0], { form_url: "https://dailyplaylists.com/submit-song/add-song" });
  const rel = await releaseRouteHoldsForTarget(sb, "t-fixed", "claude_playlist_discovery");
  assertEquals(rel.released, ["r-held"]);
  const packet = tables.agh_handoff_records[0].packet as Row;
  assertEquals(packet.route_hold, undefined);
  assertEquals(packet.form_url, "https://dailyplaylists.com/submit-song/add-song");
  assertEquals(((packet.route_hold_released as Row).prior as Row).code, "missing_form_url");
});

Deno.test("boundary: email readiness uses the draft recipient and fails closed on query error", async () => {
  const sb = stubSb({
    playlist_targets: [{ playlist_id: "t-mail", verification_status: "auto_verified", path_verified: false, contact_method: "email", curator_email: null }],
  });
  const withRecipient = await checkTargetSubmissionReady(sb, "t-mail", "email", { curator_email: "curator@label.example" });
  assertEquals(withRecipient.ok, true);
  const without = await checkTargetSubmissionReady(sb, "t-mail", "email");
  assertEquals(without.code, "missing_curator_email");

  // deno-lint-ignore no-explicit-any
  const broken: any = {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: { message: "timeout" } }) }) }),
    }),
  };
  const failed = await checkTargetSubmissionReady(broken, "t-mail", "email");
  assertEquals(failed.ok, false);
  assertEquals(failed.code, "route_check_failed");
});

Deno.test("route: evidence must tie the playlist to the form's site (live batch af913aa5)", () => {
  // Another curator's playlist + the DailyPlaylists homepage + generic search evidence → not a route.
  const unlinked = assertSubmissionReady(webFormTarget({
    form_url: "https://dailyplaylists.com/",
    form_source_evidence:
      "Spotify playlist 'Best New Hip Hop (2026)' by curator Daily Fresh Finds, surfaced in a search for rap playlists accepting free 2026 submissions.",
  }), "web_form");
  assertEquals(unlinked.code, "evidence_not_linked_to_form");
  // Same homepage, but the evidence names the curator's own portal → route.
  assertEquals(assertSubmissionReady(webFormTarget({
    form_url: "https://dailyplaylists.com/",
    form_source_evidence: "Spotify playlist 'Hip Hop Daily' owned by curator Daily Playlists, whose own submission portal is dailyplaylists.com.",
  }), "web_form").ok, true);
  // Soundplate / playlistdock / help-music packets from 2026-09-27 stay valid.
  assertEquals(assertSubmissionReady(webFormTarget({
    form_url: "https://play.soundplate.com/nauhh",
    form_source_evidence: "soundplate.com/new-and-undiscovered-hip-hop-spotify-playlist-submit-music-here/ fetched 2026-09-23; play.soundplate.com/nauhh fetched same run.",
  }), "web_form").ok, true);
  assertEquals(assertSubmissionReady(webFormTarget({
    form_url: "https://playlistdock.com/playlist.php?slug=rap-frequency-rap-hip-ho-trap-concious-rap",
    form_source_evidence: "playlistdock.com/playlist.php?slug=rap-frequency fetched 2026-09-23",
  }), "web_form").ok, true);
  assertEquals(assertSubmissionReady(webFormTarget({
    form_url: "https://www.help-music.com/proponi-il-tuo-brano/",
    form_source_evidence: "description states \"all genres added directly from the artists. www.help-music.com\"",
  }), "web_form").ok, true);
  // The listing page (source_url) naming the site also links it.
  assertEquals(assertSubmissionReady(webFormTarget({
    form_url: "https://play.soundplate.com/theunder",
    form_source_evidence: "listed with a submit link",
    research_context: { source_url: "https://soundplate.com/slimdog-productions-presents-the-undergrizzle/" },
  }), "web_form").ok, true);
  // Hosted form builders identify one specific form by URL.
  assertEquals(assessSubmissionRoute({ form_url: "https://forms.gle/AbC123", form_source_evidence: "curator bio links a submission form" }, "web_form").ok, true);
});

Deno.test("route: inactive (hard-bounced) targets are never submission-ready", () => {
  const r = assertSubmissionReady({
    verification_status: "auto_verified",
    contact_method: "email",
    curator_email: "jointheplaylist@teamspecific.com",
    is_active: false,
  }, "email");
  assertEquals(r.code, "target_inactive");
});

// ---------------------------------------------------------------------------
// 2026-09-28: bounce suppression, route actionability, record-level review.
// ---------------------------------------------------------------------------

Deno.test("boundary: a hard-bounced curator email is suppressed through every playlist association", async () => {
  const sb = stubSb({
    playlist_targets: [
      { playlist_id: "ts-new", verification_status: "auto_verified", contact_method: "email", curator_email: "jointheplaylist@teamspecific.test", bounce_count: 0, is_active: true },
      { playlist_id: "ts-old", verification_status: "bounced", contact_method: "email", curator_email: "JoinThePlaylist@teamspecific.test", bounce_count: 1, is_active: true },
      { playlist_id: "clean", verification_status: "auto_verified", contact_method: "email", curator_email: "curator@label.example", bounce_count: 0, is_active: true },
    ],
  });
  const blocked = await checkTargetSubmissionReady(sb, "ts-new", "email");
  assertEquals(blocked.ok, false);
  assertEquals(blocked.code, "curator_email_suppressed");
  assert(blocked.reason.includes("ts-old"));
  assertEquals((await checkTargetSubmissionReady(sb, "clean", "email")).ok, true);
});

Deno.test("route actionability: present vs verified vs manual action vs terms vs completed", () => {
  const soundplate = webFormTarget({
    form_url: "https://play.soundplate.com/raphhrats",
    form_source_evidence: "Soundplate per-playlist submission page fetched 2026-09-28. No page-level free/paid statement - flagged.",
    submission_cost: "unknown",
    form_login_required: null,
  });
  const pending = routeActionability(soundplate, { submission_channel: "web_form", submitted_at: null });
  assertEquals(pending.stage, "route_verified_action_pending");
  assertEquals(pending.route_verified, true);
  assertEquals(pending.manual_action_required, true);
  assertEquals(pending.terms, "unknown");
  assertEquals(pending.terms_confirmed, false);
  assertEquals(pending.login_required, null);
  assertEquals(pending.submission_completed, false);

  const done = routeActionability(soundplate, { submission_channel: "web_form", submitted_at: "2026-09-28T15:00:00Z", manual_submit_result: "submitted" });
  assertEquals(done.stage, "submitted_with_evidence");
  assert(String(done.submission_evidence).includes("2026-09-28T15:00:00Z"));

  const noRoute = routeActionability(webFormTarget({ form_url: null, submission_url: null }), { submission_channel: "web_form" });
  assertEquals(noRoute.stage, "no_route");

  const email = { playlist_id: "e", verification_status: "auto_verified", contact_method: "email", curator_email: "c@label.example", is_active: true };
  const drafted = routeActionability(email, { submission_channel: "email", outreach_draft_id: "d1" }, { emailSent: false });
  assertEquals(drafted.submission_completed, false);
  assert(drafted.notes.includes("drafted, not submitted"));
  const sentNoId = routeActionability(email, { submission_channel: "email" }, { emailSent: true, emailProviderId: null });
  assertEquals(sentNoId.submission_completed, false);
  const sent = routeActionability(email, { submission_channel: "email" }, { emailSent: true, emailProviderId: "re_123" });
  assertEquals(sent.stage, "submitted_with_evidence");
});

Deno.test("batch summary: record states are authoritative and a mixed batch says so", () => {
  const s = batchStatusSummary("AWAITING_GROK_REVIEW", { AWAITING_GROK_REVIEW: 1, REJECTED_BY_GROK: 30 });
  assertEquals(s.mixed, true);
  assertEquals(s.actionable_records, 1);
  assertEquals(s.rejected_records, 30);
  assert(String(s.summary).includes("30 REJECTED_BY_GROK"));
  assertEquals(batchStatusSummary("AWAITING_GROK_REVIEW", { AWAITING_GROK_REVIEW: 13 }).mixed, false);
});

function fitTables() {
  return {
    tracks: [{ id: "meditate", approved_song_dna_version_id: "dna-m" }],
    song_dna_versions: [{
      id: "dna-m", track_id: "meditate", approval_state: "approved", primary_genre: "hip_hop_rap",
      approved_lanes: ["rap_general", "rap_trap_hype", "rap_conscious"], excluded_lanes: ["house_club"],
    }],
    playlist_targets: [
      webFormTarget({ playlist_id: "p-trap", lane: "rap_trap_hype" }),
      webFormTarget({ playlist_id: "p-house", lane: "house_club" }),
    ],
    agh_handoff_batches: [{ id: "b-m", batch_kind: "playlist", queue_state: "AWAITING_GROK_REVIEW", track_id: "meditate", discovered_by: "claude_playlist_discovery" }],
    agh_handoff_records: [
      { id: "r-trap", batch_id: "b-m", track_id: "meditate", playlist_target_id: "p-trap", queue_state: "AWAITING_GROK_REVIEW", submission_channel: "web_form", packet: {} },
      { id: "r-house", batch_id: "b-m", track_id: "meditate", playlist_target_id: "p-house", queue_state: "AWAITING_GROK_REVIEW", submission_channel: "web_form", packet: {} },
    ],
  } as Record<string, Row[]>;
}

Deno.test("record review: a DNA/lane rejection the approved DNA contradicts is refused per record; others apply", async () => {
  const calls: Row[] = [];
  const sb = stubSb(fitTables(), {
    agh_review_handoff_records: (args) => (calls.push(args), { data: { ok: true, applied_count: (args.p_decisions as Row[]).length }, error: null }),
  });
  const res = await reviewHandoffRecords(sb, {
    batch_id: "b-m",
    decisions: [
      { record_id: "r-trap", decision: "reject", reason_code: "DNA_LANE_MISMATCH", reason: "Meditate hip_hop_rap only" },
      { record_id: "r-house", decision: "reject", reason_code: "DNA_LANE_MISMATCH", reason: "house lane" },
    ],
  }, grokActor());
  assertEquals(res.status, 200);
  const conflicts = res.data.conflicts as Row[];
  assertEquals(conflicts.map((c) => c.record_id), ["r-trap"]);
  assertEquals(conflicts[0].code, "fit_decision_conflict");
  const sent = calls[0].p_decisions as Row[];
  assertEquals(sent.map((d) => d.record_id), ["r-house"]);
  assertEquals((sent[0].song_fit as Row).code, "lane_excluded");
  assertEquals(calls[0].p_actor, "grok_playlist_control");
});

Deno.test("record review: Claude can't make record decisions; non-fit rejections are Grok's call", async () => {
  const sb = stubSb(fitTables(), { agh_review_handoff_records: () => ({ data: { ok: true }, error: null }) });
  const claude = await reviewHandoffRecords(sb, { batch_id: "b-m", decisions: [{ record_id: "r-trap", decision: "reviewed" }] }, playlistDiscoveryActor());
  assertEquals(claude.status, 403);
  const lang = await reviewHandoffRecords(sb, {
    batch_id: "b-m",
    decisions: [{ record_id: "r-trap", decision: "reject", reason_codes: ["LANGUAGE_MISMATCH", "LOW_REACH"] }],
  }, grokActor());
  assertEquals(lang.status, 200);
  assertEquals((lang.data.conflicts as Row[]).length, 0);
});

Deno.test("batch reject: fit reason blocked when a record's lane is approved; other reasons go review→reject", async () => {
  const tables = fitTables();
  const advances: Row[] = [];
  const sb = stubSb(tables, {
    advance_agh_handoff_batch: (args) => {
      advances.push(args);
      tables.agh_handoff_batches[0].queue_state = args.p_next_state;
      return { data: { ok: true, batch: tables.agh_handoff_batches[0], records_updated: 2 }, error: null };
    },
  });
  const fitReject = await reviewHandoffBatch(sb, { batch_id: "b-m", decision: "reject", rejection_reason: "DNA_LANE_MISMATCH Meditate hip_hop_rap only" }, grokActor());
  assertEquals(fitReject.status, 409);
  assertEquals(fitReject.data.code, "fit_decision_conflict");
  assertEquals((fitReject.data.fitting_records as Row[]).map((r) => r.record_id), ["r-trap"]);
  assertEquals(advances.length, 0);

  const other = await reviewHandoffBatch(sb, { batch_id: "b-m", decision: "reject", rejection_reason: "LOW_REACH: all under 300 followers" }, grokActor());
  assertEquals(other.status, 200);
  assertEquals(advances.map((a) => `${a.p_expected_state}->${a.p_next_state}`), [
    "AWAITING_GROK_REVIEW->GROK_REVIEWED",
    "GROK_REVIEWED->REJECTED_BY_GROK",
  ]);
});
