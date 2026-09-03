// AGH P0-A — regression cover for the Eligibility Containment Gate.
// Run: deno test supabase/functions/_shared/outreach-eligibility.test.ts
//
// The headline regression (AGH-001): a "Meditate"-shaped track — present in the
// catalogue, no category, sitting on the fail-closed `needs_song_intelligence`
// default — must be refused at BOTH the draft path and the send path, before
// send #1, with every bypass flag turned on and with no draft_id at all.
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  DEFAULT_OUTREACH_ELIGIBILITY,
  OUTREACH_ELIGIBILITY_STATES,
  asOutreachEligibility,
  checkDraftEligibilityById,
  checkDraftEligibilityByName,
  checkSendEligibility,
  eligibilitySkipLog,
  evaluateTrackEligibility,
  isSendEligible,
  type SendBypassFlags,
} from "./outreach-eligibility.ts";

// ---------------------------------------------------------------------------
// Fixtures — the two real tracks in play, plus the shapes that must fail closed.
// ---------------------------------------------------------------------------

/** "Designed For Me (Control)" as the migration backfills it: artist-cleared. */
const DFM = {
  id: "trk-dfm",
  name: "Designed For Me (Control)",
  outreach_eligibility: "eligible",
  eligibility_reason: "Artist-verified 2026-08-27.",
  eligibility_source: "migration",
  eligibility_set_by: "fendi-approved-2026-08-27",
  eligibility_si_version: "si-2026-07-19-category-backfill",
};

/** AGH-001. "Meditate" as it was at the time of the incident: in the catalogue,
 *  no category, never cleared — so it sits on the fail-closed column DEFAULT. */
const MEDITATE_UNCLEARED = {
  id: "trk-meditate",
  name: "Meditate",
  outreach_eligibility: "needs_song_intelligence",
  eligibility_reason: null,
  eligibility_source: null,
  eligibility_set_by: null,
  eligibility_si_version: null,
};

/** Minimal stub of the PostgREST surface the gate touches. `tracks` rows are
 *  matched by id (.eq) or case-insensitively by name (.ilike), mirroring the
 *  unique index on lower(name). */
// deno-lint-ignore no-explicit-any
function stubClient(rows: any[], error: { message?: string; code?: string } | null = null): any {
  return {
    from: (_table: string) => {
      // deno-lint-ignore no-explicit-any
      let match: (r: any) => boolean = () => true;
      const chain = {
        select: () => chain,
        // deno-lint-ignore no-explicit-any
        eq: (col: string, val: any) => {
          match = (r) => String(r[col]) === String(val);
          return chain;
        },
        // deno-lint-ignore no-explicit-any
        ilike: (col: string, val: any) => {
          match = (r) => String(r[col] ?? "").toLowerCase() === String(val ?? "").toLowerCase();
          return chain;
        },
        maybeSingle: () =>
          Promise.resolve(
            error ? { data: null, error } : { data: rows.find(match) ?? null, error: null },
          ),
      };
      return chain;
    },
  };
}

/** Every combination of the three bypass flags, with and without a draft_id.
 *  Named so a failure says exactly which combination leaked. */
function allBypassCombinations(): { label: string; flags: SendBypassFlags }[] {
  const out: { label: string; flags: SendBypassFlags }[] = [];
  for (const testMode of [false, true]) {
    for (const batchOverrideCap of [false, true]) {
      for (const ignoreSendWindow of [false, true]) {
        for (const draftId of [null, "draft-123"]) {
          out.push({
            label: `test_mode=${testMode} batch_override_cap=${batchOverrideCap} ` +
              `ignore_send_window=${ignoreSendWindow} draft_id=${draftId ?? "(none)"}`,
            flags: { testMode, batchOverrideCap, ignoreSendWindow, draftId },
          });
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The state machine
// ---------------------------------------------------------------------------

Deno.test("the four states are exactly the migration's enum, and the default is fail-closed", () => {
  assertEquals([...OUTREACH_ELIGIBILITY_STATES], [
    "eligible",
    "needs_song_intelligence",
    "no_genre_lane",
    "blocked",
  ]);
  assertEquals(DEFAULT_OUTREACH_ELIGIBILITY, "needs_song_intelligence");
});

Deno.test("isSendEligible allows ONLY 'eligible' — never 'not blocked'", () => {
  assert(isSendEligible("eligible"));
  for (const s of ["needs_song_intelligence", "no_genre_lane", "blocked"]) {
    assertEquals(isSendEligible(s), false, `${s} must not permit a send`);
  }
  // Unknown / absent values are refusals, not passes. A future enum value added
  // in the database must not silently become sendable.
  for (const s of [null, undefined, "", "ELIGIBLE", "approved", "pending_review", 1, true]) {
    assertEquals(isSendEligible(s), false, `${String(s)} must not permit a send`);
  }
  assertEquals(asOutreachEligibility("approved"), null);
});

// ---------------------------------------------------------------------------
// AGH-001 regression — Meditate is blocked on BOTH paths, before send #1
// ---------------------------------------------------------------------------

Deno.test("AGH-001 regression: Meditate-shaped track is BLOCKED at the SEND path", async () => {
  const sb = stubClient([DFM, MEDITATE_UNCLEARED]);
  const d = await checkSendEligibility(sb, "Meditate");
  assertEquals(d.allowed, false);
  assert(!d.allowed);
  assertEquals(d.state, "needs_song_intelligence");
  assertEquals(d.reason, "not_eligible");
  assertStringIncludes(d.message, "Meditate");
  assertStringIncludes(d.message, "not \"eligible\"");
});

Deno.test("AGH-001 regression: Meditate-shaped track is BLOCKED at the DRAFT path", async () => {
  // By id — the composer's track_id branch, which evaluates the already-loaded row.
  const fromRow = evaluateTrackEligibility(MEDITATE_UNCLEARED, "Meditate");
  assertEquals(fromRow.allowed, false);
  assert(!fromRow.allowed);
  assertEquals(fromRow.reason, "not_eligible");

  const sb = stubClient([DFM, MEDITATE_UNCLEARED]);
  const byId = await checkDraftEligibilityById(sb, "trk-meditate", "Meditate");
  assertEquals(byId.allowed, false);

  // By name — the catalogue-pick branch, which has no track_id.
  const byName = await checkDraftEligibilityByName(sb, "meditate");
  assertEquals(byName.allowed, false);
  assert(!byName.allowed);
  assertEquals(byName.state, "needs_song_intelligence");
});

Deno.test("AGH-001 regression: a track that has NEVER been decided fails closed", async () => {
  // The column DEFAULT, as every non-backfilled track in the catalogue carries it.
  const sb = stubClient([{ id: "trk-new", name: "Some New Song", outreach_eligibility: DEFAULT_OUTREACH_ELIGIBILITY }]);
  const d = await checkSendEligibility(sb, "Some New Song");
  assertEquals(d.allowed, false);
});

// ---------------------------------------------------------------------------
// INVARIANT 1 — bypass flags waive their named behaviour, never eligibility
// ---------------------------------------------------------------------------

Deno.test("INVARIANT: no bypass flag (or combination) bypasses the eligibility gate", async () => {
  const sb = stubClient([DFM, MEDITATE_UNCLEARED]);
  const combos = allBypassCombinations();
  assertEquals(combos.length, 16, "expected all 2^4 flag combinations");
  for (const { label, flags } of combos) {
    const d = await checkSendEligibility(sb, "Meditate", flags);
    assertEquals(d.allowed, false, `eligibility leaked with ${label}`);
    assert(!d.allowed);
    assertEquals(d.reason, "not_eligible", `wrong refusal reason with ${label}`);
  }
});

Deno.test("INVARIANT: 'blocked' is refused under every bypass flag too", async () => {
  const sb = stubClient([{ id: "trk-x", name: "Embargoed", outreach_eligibility: "blocked", eligibility_reason: "Rights hold." }]);
  for (const { label, flags } of allBypassCombinations()) {
    const d = await checkSendEligibility(sb, "Embargoed", flags);
    assertEquals(d.allowed, false, `blocked track leaked with ${label}`);
  }
});

Deno.test("INVARIANT: the bypass flags do not change the decision for an ELIGIBLE track either", async () => {
  // The gate is a function of eligibility alone — flags must not flip it in
  // either direction, so a future "flags imply eligible" shortcut fails here.
  const sb = stubClient([DFM]);
  for (const { label, flags } of allBypassCombinations()) {
    const d = await checkSendEligibility(sb, DFM.name, flags);
    assertEquals(d.allowed, true, `eligible track wrongly refused with ${label}`);
  }
});

// ---------------------------------------------------------------------------
// The draft-less bypass — a bare {playlist_id, track_name} send
// ---------------------------------------------------------------------------

Deno.test("draft-less bare playlist_id send is blocked (no draft_id, no draft-time refusal)", async () => {
  const sb = stubClient([DFM, MEDITATE_UNCLEARED]);
  // Exactly the shape execute-pitch receives for a draft-less call: a track name
  // and no draft_id, so nothing in runDraftPitch ever ran for this send.
  const d = await checkSendEligibility(sb, "Meditate", { draftId: null });
  assertEquals(d.allowed, false);
  assert(!d.allowed);
  assertEquals(d.reason, "not_eligible");
});

Deno.test("a track name that is not in the catalogue at all is refused (unknown_track)", async () => {
  const sb = stubClient([DFM]);
  const d = await checkSendEligibility(sb, "Some Song Nobody Added");
  assertEquals(d.allowed, false);
  assert(!d.allowed);
  assertEquals(d.reason, "unknown_track");
  assertEquals(d.state, null);
});

Deno.test("an empty track name is refused rather than matching the first row", async () => {
  const sb = stubClient([DFM]);
  const d = await checkSendEligibility(sb, "   ");
  assertEquals(d.allowed, false);
  assert(!d.allowed);
  assertEquals(d.reason, "unknown_track");
});

// ---------------------------------------------------------------------------
// DFM still sends — the unblock this change must not regress
// ---------------------------------------------------------------------------

Deno.test("DFM (eligible) still passes the send gate", async () => {
  const sb = stubClient([DFM, MEDITATE_UNCLEARED]);
  const d = await checkSendEligibility(sb, "Designed For Me (Control)");
  assertEquals(d.allowed, true);
  assert(d.allowed);
  assertEquals(d.state, "eligible");
  assertEquals(d.trackId, "trk-dfm");
});

Deno.test("DFM matches case-insensitively, as tracks' unique lower(name) index implies", async () => {
  const sb = stubClient([DFM]);
  const d = await checkSendEligibility(sb, "designed for me (control)");
  assertEquals(d.allowed, true);
});

Deno.test("DFM (eligible) still passes the draft gate", async () => {
  const sb = stubClient([DFM]);
  assertEquals((await checkDraftEligibilityById(sb, "trk-dfm", DFM.name)).allowed, true);
  assertEquals((await checkDraftEligibilityByName(sb, DFM.name)).allowed, true);
  assertEquals(evaluateTrackEligibility(DFM, DFM.name).allowed, true);
});

// ---------------------------------------------------------------------------
// Fail-closed on infrastructure problems
// ---------------------------------------------------------------------------

Deno.test("code deployed ahead of the migration fails CLOSED, with a diagnosable reason", async () => {
  // Selecting the eligibility columns errors before the migration is applied.
  const sb = stubClient([], { code: "42703", message: 'column tracks.outreach_eligibility does not exist' });
  const d = await checkSendEligibility(sb, "Designed For Me (Control)");
  assertEquals(d.allowed, false);
  assert(!d.allowed);
  assertEquals(d.reason, "eligibility_schema_missing");
  assertStringIncludes(d.message, "migration");
});

Deno.test("a row selected with '*' before the migration also fails closed", () => {
  // The draft path selects `*`, so a pre-migration row simply lacks the column.
  const d = evaluateTrackEligibility({ id: "t", name: "Meditate" }, "Meditate");
  assertEquals(d.allowed, false);
  assert(!d.allowed);
  assertEquals(d.reason, "eligibility_schema_missing");
});

Deno.test("a transient lookup failure fails CLOSED, not open", async () => {
  const sb = stubClient([], { code: "57014", message: "canceling statement due to statement timeout" });
  const d = await checkSendEligibility(sb, "Designed For Me (Control)");
  assertEquals(d.allowed, false);
  assert(!d.allowed);
  assertEquals(d.reason, "eligibility_lookup_failed");
});

Deno.test("a null column value is treated as the fail-closed default", () => {
  const d = evaluateTrackEligibility({ id: "t", name: "X", outreach_eligibility: null }, "X");
  assertEquals(d.allowed, false);
  assert(!d.allowed);
  assertEquals(d.state, DEFAULT_OUTREACH_ELIGIBILITY);
});

// ---------------------------------------------------------------------------
// INVARIANT 2 — the send path only READS eligibility
// ---------------------------------------------------------------------------

Deno.test("INVARIANT: this module exposes no way to promote a track to 'eligible'", async () => {
  const src = await Deno.readTextFile(new URL("./outreach-eligibility.ts", import.meta.url));
  // No writer of any kind: no insert/update/upsert against the catalogue.
  for (const w of [".update(", ".insert(", ".upsert(", ".rpc("]) {
    assertEquals(src.includes(w), false, `eligibility module must not call ${w}`);
  }
});

Deno.test("INVARIANT: neither send path nor draft path writes eligibility", async () => {
  const sends = await Deno.readTextFile(new URL("../execute-pitch/index.ts", import.meta.url));
  const drafts = await Deno.readTextFile(new URL("./playlist-agent-run.ts", import.meta.url));
  for (const [label, src] of [["execute-pitch", sends], ["playlist-agent-run", drafts]] as const) {
    // Automation may only ever move a track to a MORE restrictive state, and
    // returning to 'eligible' is out of scope for P0-A — so neither path may
    // write any eligibility column. Reading it into a refusal payload is fine;
    // what must not exist is an eligibility key inside a database write, so scan
    // the payload of every write call rather than the whole file.
    for (const writer of [".update(", ".insert(", ".upsert(", ".rpc("]) {
      let at = src.indexOf(writer);
      while (at > -1) {
        const payload = src.slice(at, at + 600);
        assertEquals(
          payload.includes("eligibility"),
          false,
          `${label} must not write an eligibility column (${writer} near offset ${at})`,
        );
        at = src.indexOf(writer, at + 1);
      }
    }
    // Belt and braces: neither path may hand the literal cleared state to anything.
    assertEquals(
      /outreach_eligibility\s*:\s*["']eligible["']/.test(src),
      false,
      `${label} must never set a track to 'eligible'`,
    );
  }
});

// ---------------------------------------------------------------------------
// Wiring — the guard is actually installed, in the right place, unconditionally
// ---------------------------------------------------------------------------

Deno.test("WIRING: execute-pitch calls the gate at the TOP of handleEmailPitch, before the cooldown block", async () => {
  const src = await Deno.readTextFile(new URL("../execute-pitch/index.ts", import.meta.url));
  const handler = src.slice(src.indexOf("async function handleEmailPitch"));
  assert(handler.length > 0, "handleEmailPitch not found");

  const gateAt = handler.indexOf("checkSendEligibility(");
  const testModeBlockAt = handler.indexOf("if (!testMode) {");
  const cooldownAt = handler.indexOf('.eq("status", "sent")');
  const capAt = handler.indexOf("PER_SONG_DAILY_PITCHES");
  const windowAt = handler.indexOf("isWithinSendWindow(");
  const sendAt = handler.indexOf("https://api.resend.com/emails");

  assert(gateAt > -1, "handleEmailPitch does not call checkSendEligibility");
  // Before every capacity/window control, and before the actual send.
  for (const [label, at] of [["send window", windowAt], ["cooldown", cooldownAt], ["daily cap", capAt], ["resend call", sendAt]] as const) {
    assert(at > -1, `${label} not found in handleEmailPitch`);
    assert(gateAt < at, `eligibility gate must run before the ${label}`);
  }
  // And OUTSIDE the `if (!testMode)` block, so test_mode cannot skip it.
  assert(testModeBlockAt > -1, "the !testMode block moved — re-check the gate placement");
  assert(gateAt < testModeBlockAt, "eligibility gate must sit outside/above the !testMode block");
});

Deno.test("WIRING: runDraftPitch refuses on eligibility before the category and pitch-copy gates", async () => {
  const src = await Deno.readTextFile(new URL("./playlist-agent-run.ts", import.meta.url));
  const fn = src.slice(src.indexOf("export async function runDraftPitch"));
  assert(fn.length > 0, "runDraftPitch not found");

  const gateAt = fn.indexOf("evaluateTrackEligibility(");
  const categoryAt = fn.indexOf("categoryGate({");
  const copyAt = fn.indexOf("resolvePitchAngle(");

  assert(gateAt > -1, "runDraftPitch does not evaluate eligibility");
  assert(gateAt < categoryAt, "eligibility must be decided before the category gate");
  assert(gateAt < copyAt, "eligibility must be decided before pitch-copy resolution");
});

Deno.test("WIRING: no override_* flag is wired to the eligibility refusal", async () => {
  const src = await Deno.readTextFile(new URL("./playlist-agent-run.ts", import.meta.url));
  const fn = src.slice(src.indexOf("export async function runDraftPitch"));
  const gateAt = fn.indexOf("const draftEligibility =");
  const block = fn.slice(gateAt, fn.indexOf("const channel = pickChannel", gateAt));
  assertEquals(/override_/.test(block), false, "the eligibility refusal must have no override escape hatch");
});

// ---------------------------------------------------------------------------
// Skip logging
// ---------------------------------------------------------------------------

Deno.test("the skip log carries the reason, state and context — and no recipient data", () => {
  const d = evaluateTrackEligibility(MEDITATE_UNCLEARED, "Meditate");
  assert(!d.allowed);
  const log = eligibilitySkipLog(d, { playlist_id: "spotify:abc", test_mode: true });
  assertEquals(log.gate, "outreach_eligibility");
  assertEquals(log.skip_reason, "not_eligible");
  assertEquals(log.outreach_eligibility, "needs_song_intelligence");
  assertEquals(log.track_name, "Meditate");
  assertEquals(log.playlist_id, "spotify:abc");
  assertEquals(log.test_mode, true);
  assertEquals(JSON.stringify(log).includes("@"), false, "skip log must not carry an email address");
});
