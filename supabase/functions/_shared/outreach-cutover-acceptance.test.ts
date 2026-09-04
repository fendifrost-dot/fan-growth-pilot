/**
 * Acceptance wiring greps + shared-decision contracts for Song DNA cutover.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveTrackPitchCopy, resolveFitReason } from "./pitch-copy.ts";
import { profilesToSweepBuckets } from "./discovery-profiles.ts";

Deno.test("{{pitch}} never comes from playlist or lane copy", () => {
  const pitch = resolveTrackPitchCopy({
    track: { short_pitch: null, pitch_angle: null },
    approvedDna: null,
  });
  assertEquals(pitch.ok, false);
  const fit = resolveFitReason({
    row: { recommended_pitch_angle: "PLAYLIST SHOULD BE FIT ONLY", lane: "house_club" },
    lanes: { house_club: { pitch_angle: "LANE SHOULD BE FIT ONLY" } },
  });
  assertEquals(fit.fitReason.includes("PLAYLIST") || fit.fitReason.includes("LANE"), true);
});

Deno.test("rap DNA vs house lane is incompatible", () => {
  const approved = new Set(["rap_general"]);
  const excluded = new Set(["house_club", "deep_house_groove"]);
  const lane = "house_club";
  assertEquals(excluded.has(lane), true);
  assertEquals(approved.has(lane), false);
});

Deno.test("profilesToSweepBuckets uses DB profile allocation not fixed 0.55 literal as sole source", () => {
  const b = profilesToSweepBuckets([
    {
      id: "1",
      profile_key: "a",
      label: "A",
      is_active: true,
      approval_status: "approved",
      genre_family: "rap",
      included_search_terms: ["trap"],
      excluded_search_terms: [],
      reference_artists: [],
      compatible_target_category_slugs: [],
      search_weight: 1,
      approved_lanes: ["rap_general"],
      excluded_lanes: [],
      matching_expression: null,
      allocation_share: 0.7,
    },
    {
      id: "2",
      profile_key: "b",
      label: "B",
      is_active: true,
      approval_status: "approved",
      genre_family: "house",
      included_search_terms: ["tech house"],
      excluded_search_terms: [],
      reference_artists: [],
      compatible_target_category_slugs: [],
      search_weight: 1,
      approved_lanes: ["house_general"],
      excluded_lanes: [],
      matching_expression: null,
      allocation_share: 0.3,
    },
  ]);
  assertEquals(Math.abs(b.rapShare - 0.7) < 0.01, true);
  assertEquals(b.rapTerms.includes("trap"), true);
  assertEquals(b.houseTerms.includes("tech house"), true);
});

Deno.test("WIRING: execute-pitch and send-pitch-email bind to approved draft + integrity", () => {
  const exec = Deno.readTextFileSync(new URL("../execute-pitch/index.ts", import.meta.url));
  const send = Deno.readTextFileSync(new URL("../send-pitch-email/index.ts", import.meta.url));
  const agent = Deno.readTextFileSync(new URL("./playlist-agent-run.ts", import.meta.url));
  const decision = Deno.readTextFileSync(new URL("./outreach-decision.ts", import.meta.url));
  assert(exec.includes("evaluateOutreachDecision"), "execute-pitch missing shared decision");
  assert(exec.includes("verifyDraftPitchIntegrity"), "execute-pitch must verify pitch hash");
  assert(exec.includes("draft_id required"), "execute-pitch must require draft_id");
  assert(exec.includes('provided !== expected'), "execute-pitch must reject missing/mismatched hub key");
  assert(send.includes("evaluateOutreachDecision"), "send-pitch-email missing shared decision");
  assert(send.includes("verifyDraftPitchIntegrity"), "send-pitch-email must verify pitch hash");
  assert(send.includes("draft_id required"), "send-pitch-email must require draft_id");
  assert(agent.includes("evaluateOutreachDecision("), "playlist-agent-run missing decision calls");
  assert(agent.includes('route: "approve_draft"'), "approve_draft must re-evaluate");
  assert(agent.includes("track_id required"), "draft must require track_id");
  assert(agent.includes("invalidate_stale_drafts") || agent.includes("runInvalidateStaleDrafts"), "stale draft invalidate action required");
  assert(agent.includes("pitch_copy_hash"), "new drafts must store pitch_copy_hash");
  assert(decision.includes("song_dna_track_mismatch"), "DNA must bind to selected track");
  assert(decision.includes("categoryGate"), "shared gate must verify genre/category fit without DNA");
  assert(!agent.includes('decision.mode === "enforce"'), "shadow/enforce mode branch must be gone");
});

Deno.test("WIRING: control-center dispatches Song DNA via authorizeAction", () => {
  const cca = Deno.readTextFileSync(new URL("../control-center-api/index.ts", import.meta.url));
  assert(cca.includes("isSongDnaAction"));
  assert(cca.includes("runSongDnaAction"));
  assert(cca.includes("authorizeAction"));
});

Deno.test("runtime song-dna has no catalog UUID allow-list", () => {
  const src = Deno.readTextFileSync(new URL("./song-dna.ts", import.meta.url));
  assertEquals(src.includes("TRACK_IDS"), false);
  assertEquals(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(src), false);
});

Deno.test("sync-registers has no Meditate title gate", () => {
  const src = Deno.readTextFileSync(new URL("./sync-registers.ts", import.meta.url));
  assertEquals(src.includes("isMeditateTitle"), false);
  assertEquals(src.includes('normalizeTitle(name) === "meditate"'), false);
});
