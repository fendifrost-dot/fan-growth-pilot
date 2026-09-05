/**
 * Systemic Song-DNA enforcement — Phases 4–8 directive cases.
 * Run: deno test supabase/functions/_shared/song-dna-enforcement.test.ts
 *
 * MEDITATE title literal is allowed in tests only.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  AUTHORIZED_DRAFT_APPROVERS,
  hashApprovalArtifact,
  verifyApprovedContentHash,
} from "./pitch-copy-integrity.ts";
import { evaluateOutreachDecision } from "./outreach-decision.ts";
import { can, resolveOpsActor, stripSpoofedAttribution } from "./ops-actors.ts";
import type { Actor } from "./outreach-auth.ts";
import { evaluateTrackEligibility } from "./outreach-eligibility.ts";

type Row = Record<string, unknown>;

function stubSb(tables: Record<string, Row[]>): {
  // deno-lint-ignore no-explicit-any
  from: (table: string) => any;
} {
  const from = (table: string) => {
    let rows: Row[] = (tables[table] ?? []).map((r) => ({ ...r }));
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (col: string, val: unknown) => {
        rows = rows.filter((r) => r[col] === val || String(r[col]) === String(val));
        return chain;
      },
      in: (col: string, vals: unknown[]) => {
        const set = new Set(vals.map(String));
        rows = rows.filter((r) => set.has(String(r[col])));
        return chain;
      },
      not: () => chain,
      or: () => chain,
      order: () => chain,
      limit: (n: number) => {
        rows = rows.slice(0, n);
        return chain;
      },
      maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
      single: () => Promise.resolve({ data: rows[0] ?? null, error: rows[0] ? null : { message: "no row" } }),
      insert: () => Promise.resolve({ data: null, error: null }),
      update: () => chain,
      then: (resolve: (v: { data: Row[]; error: null; count?: number }) => unknown) =>
        Promise.resolve({ data: rows, error: null, count: rows.length }).then(resolve),
    };
    return chain;
  };
  return { from };
}

const MEDITATE_PITCH = "Meditate is a late-night rap record.";

const TRACK = {
  id: "track-meditate",
  name: "Meditate",
  short_pitch: "LEGACY TRACK PITCH MUST NOT AUTHORIZE",
  pitch_angle: "LEGACY ANGLE MUST NOT AUTHORIZE",
  approved_song_dna_version_id: "dna-current",
};

const DNA = {
  id: "dna-current",
  track_id: "track-meditate",
  short_pitch: MEDITATE_PITCH,
  approval_state: "approved",
  approved_lanes: ["rap_general", "rap_trap_hype"],
  excluded_lanes: ["house_club", "deep_house_groove", "house_general"],
  primary_genre: "rap",
};

const PLAYLIST_HOUSE = {
  playlist_id: "pl-house",
  lane: "house_club",
  verification_status: "auto_verified",
  recommended_pitch_angle: "HOUSE FIT ONLY",
  playlist_name: "House Night",
  curator_name: "C",
  vibe_tags: null,
  playlist_categories: [],
};

const PLAYLIST_RAP = {
  playlist_id: "pl-rap",
  lane: "rap_general",
  verification_status: "auto_verified",
  recommended_pitch_angle: "RAP FIT ONLY",
  playlist_name: "Rap Night",
  curator_name: "C",
  vibe_tags: null,
  playlist_categories: [],
};

function tables(extra: Record<string, Row[]> = {}) {
  return {
    tracks: [TRACK],
    song_dna_versions: [DNA],
    playlist_targets: [PLAYLIST_HOUSE, PLAYLIST_RAP],
    pitch_campaigns: [],
    artist_config: [{ key: "lanes", value: {} }],
    outreach_decision_shadow_log: [],
    ...extra,
  };
}

function req(agent?: string): Request {
  const headers = new Headers();
  if (agent) headers.set("x-agh-agent", agent);
  return new Request("https://example.test", { headers });
}

function user(userId: string): Actor {
  return { kind: "user", userId, isAdmin: true };
}

// ---- 1–7 DNA / lane envelope ----

Deno.test("1 excluded lane is blocked", async () => {
  const d = await evaluateOutreachDecision(stubSb(tables()) as never, {
    route: "test",
    trackId: TRACK.id,
    playlistId: PLAYLIST_HOUSE.playlist_id,
    lane: "house_club",
  });
  assertEquals(d.allow, false);
  assert(d.errors.includes("dna_excluded_lane"));
});

Deno.test("2 unapproved lane (not in approved_lanes) is blocked", async () => {
  const d = await evaluateOutreachDecision(stubSb(tables()) as never, {
    route: "test",
    trackId: TRACK.id,
    playlistId: "pl-other",
    lane: "afrobeats_general",
  });
  // playlist missing → also playlist_not_found; force with rap playlist mutated
  const t = tables({
    playlist_targets: [{
      ...PLAYLIST_RAP,
      playlist_id: "pl-afro",
      lane: "afrobeats_general",
    }],
  });
  const d2 = await evaluateOutreachDecision(stubSb(t) as never, {
    route: "test",
    trackId: TRACK.id,
    playlistId: "pl-afro",
  });
  assertEquals(d2.allow, false);
  assert(d2.errors.includes("dna_lane_not_approved"));
  assertEquals(d.allow, false);
});

Deno.test("3 null lane is blocked", async () => {
  const t = tables({
    playlist_targets: [{ ...PLAYLIST_RAP, lane: null }],
  });
  const d = await evaluateOutreachDecision(stubSb(t) as never, {
    route: "test",
    trackId: TRACK.id,
    playlistId: PLAYLIST_RAP.playlist_id,
  });
  assertEquals(d.allow, false);
  assert(d.errors.includes("target_lane_null"));
});

Deno.test("4 unverified target is blocked", async () => {
  const t = tables({
    playlist_targets: [{ ...PLAYLIST_RAP, verification_status: "unverified" }],
  });
  const d = await evaluateOutreachDecision(stubSb(t) as never, {
    route: "test",
    trackId: TRACK.id,
    playlistId: PLAYLIST_RAP.playlist_id,
  });
  assertEquals(d.allow, false);
  assert(d.errors.includes("target_classification_unverified"));
});

Deno.test("5 missing DNA is blocked", async () => {
  const t = tables({
    tracks: [{ ...TRACK, approved_song_dna_version_id: null }],
  });
  const d = await evaluateOutreachDecision(stubSb(t) as never, {
    route: "test",
    trackId: TRACK.id,
    playlistId: PLAYLIST_RAP.playlist_id,
  });
  assertEquals(d.allow, false);
  assert(d.errors.includes("missing_approved_song_dna"));
});

Deno.test("6 stale DNA version is blocked", async () => {
  const stale = {
    ...DNA,
    id: "dna-stale",
    short_pitch: MEDITATE_PITCH,
  };
  const t = tables({
    song_dna_versions: [DNA, stale],
  });
  const d = await evaluateOutreachDecision(stubSb(t) as never, {
    route: "test",
    trackId: TRACK.id,
    playlistId: PLAYLIST_RAP.playlist_id,
    songDnaVersionId: "dna-stale",
  });
  assertEquals(d.allow, false);
  assert(d.errors.includes("song_dna_not_current"));
});

Deno.test("7 legacy categories cannot override DNA denial", async () => {
  // House playlist with matching "house" categories still denied by DNA excluded_lanes.
  const t = tables({
    playlist_targets: [{
      ...PLAYLIST_HOUSE,
      playlist_categories: [
        { category_id: "c1", categories: { id: "c1", slug: "deep_house", label: "Deep House", family: "house" } },
      ],
    }],
  });
  const d = await evaluateOutreachDecision(stubSb(t) as never, {
    route: "test",
    trackId: TRACK.id,
    playlistId: PLAYLIST_HOUSE.playlist_id,
    overrideCategoryCheck: true,
  });
  assertEquals(d.allow, false);
  assert(d.errors.includes("dna_excluded_lane") || d.errors.includes("override_forbidden"));
  assertEquals(d.copySource === "tracks.short_pitch", false);
});

// ---- 8–13 draft/approve actors ----

Deno.test("8 override_body rejected (wiring)", () => {
  const src = Deno.readTextFileSync(new URL("./playlist-agent-run.ts", import.meta.url));
  assert(src.includes("override_body_rejected"));
  assert(src.includes("override_subject_rejected"));
  const fn = src.slice(src.indexOf("export async function runDraftPitch"));
  const overrideInject = fn.indexOf("pitchBody = body.override_body");
  assertEquals(overrideInject, -1, "must not inject override_body into outbound body");
});

Deno.test("9 edits revoke approval (wiring)", () => {
  const src = Deno.readTextFileSync(new URL("./playlist-agent-run.ts", import.meta.url));
  const fn = src.slice(src.indexOf('if (action === "update_draft")'));
  assert(fn.includes('patch.status = "pending"'));
  assert(fn.includes("approved_content_hash = null"));
  assert(fn.includes("approval_fields_forbidden"));
});

Deno.test("10 caller approved_by ignored", () => {
  const cleaned = stripSpoofedAttribution({
    draft_id: "d1",
    approved_by: "spoofed-grok",
    generated_by: "spoofed-claude",
  });
  assertEquals(cleaned.approved_by, undefined);
  assertEquals(cleaned.generated_by, undefined);
  const src = Deno.readTextFileSync(new URL("./playlist-agent-run.ts", import.meta.url));
  assert(!src.includes('String(body.approved_by ?? "admin")'));
  assert(src.includes("opsActor.label"));
});

Deno.test("11 Claude cannot approve/send", () => {
  const actor = resolveOpsActor(user("admin-1"), req("claude"));
  assertEquals(can(actor, "approve_playlist_drafts"), false);
  assertEquals(can(actor, "send_playlist_pitches"), false);
  assertEquals(can(actor, "generate_playlist_drafts"), true);
});

Deno.test("12 scheduler cannot approve as Grok", () => {
  const spoof = resolveOpsActor({ kind: "scheduler" }, req("grok"));
  assertEquals(spoof.kind, "scheduler");
  assertEquals(can(spoof, "approve_playlist_drafts"), false);
  const pure = resolveOpsActor({ kind: "scheduler" }, null);
  assertEquals(can(pure, "approve_playlist_drafts"), false);
  const src = Deno.readTextFileSync(new URL("./playlist-agent-run.ts", import.meta.url));
  assert(src.includes("scheduler cannot approve"));
});

Deno.test("13 Grok can approve compatible draft", async () => {
  const grok = resolveOpsActor(user("admin-1"), req("grok"));
  assertEquals(can(grok, "approve_playlist_drafts"), true);
  const d = await evaluateOutreachDecision(stubSb(tables()) as never, {
    route: "approve_draft",
    trackId: TRACK.id,
    playlistId: PLAYLIST_RAP.playlist_id,
    actor: grok,
  });
  assertEquals(d.allow, true);
  assertEquals(d.copySource, "song_dna_versions.short_pitch");
  if (d.pitch.ok) assertEquals(d.pitch.pitch, MEDITATE_PITCH);
});

// ---- 14–15 hash + senders ----

Deno.test("14 full hash detects content changes", async () => {
  const base = {
    track_id: "t1",
    song_dna_version_id: "dna1",
    playlist_id: "pl1",
    campaign_id: "c1",
    channel: "email",
    recipient: "a@b.com",
    subject: "Hi",
    body: "Hello\n\n" + MEDITATE_PITCH,
    template_id: "tpl1",
  };
  const h1 = await hashApprovalArtifact(base);
  const h2 = await hashApprovalArtifact({ ...base, body: base.body + "\nP.S. changed" });
  const h3 = await hashApprovalArtifact({ ...base, subject: "Changed" });
  const h4 = await hashApprovalArtifact({ ...base, recipient: "other@b.com" });
  assertEquals(h1 === h2, false);
  assertEquals(h1 === h3, false);
  assertEquals(h1 === h4, false);

  const ok = await verifyApprovedContentHash({
    ...base,
    id: "d1",
    status: "approved",
    approved_at: new Date().toISOString(),
    approved_by: "grok_playlist_control",
    approved_content_hash: h1,
  });
  assertEquals(ok.ok, true);

  const bad = await verifyApprovedContentHash({
    ...base,
    body: "tampered",
    id: "d1",
    status: "approved",
    approved_at: new Date().toISOString(),
    approved_by: "grok_playlist_control",
    approved_content_hash: h1,
  });
  assertEquals(bad.ok, false);
  if (!bad.ok) assertEquals(bad.code, "approved_content_hash_mismatch");
});

Deno.test("15 both senders reject same invalid pair (wiring)", () => {
  const exec = Deno.readTextFileSync(new URL("../execute-pitch/index.ts", import.meta.url));
  const send = Deno.readTextFileSync(new URL("../send-pitch-email/index.ts", import.meta.url));
  for (const src of [exec, send]) {
    assert(src.includes("verifyApprovedContentHash"));
    assert(src.includes("evaluateOutreachDecision"));
    assert(src.includes("verifyDraftPitchIntegrity"));
  }
  assert(AUTHORIZED_DRAFT_APPROVERS.has("grok_playlist_control"));
  assert(AUTHORIZED_DRAFT_APPROVERS.has("fendi"));
});

// ---- 16–17 independence + no production title literals ----

Deno.test("16 P0-A eligibility remains independent of DNA gate", () => {
  const uncleared = {
    name: "Meditate",
    outreach_eligibility: "needs_song_intelligence",
    eligibility_reason: "sample_uncleared",
  };
  const d = evaluateTrackEligibility(uncleared, "Meditate");
  assertEquals(d.allowed, false);
  const src = Deno.readTextFileSync(new URL("./playlist-agent-run.ts", import.meta.url));
  const fn = src.slice(src.indexOf("export async function runDraftPitch"));
  const eligAt = fn.indexOf("evaluateTrackEligibility(");
  const dnaAt = fn.indexOf("evaluateOutreachDecision(");
  assert(eligAt > -1 && dnaAt > -1 && eligAt < dnaAt);
});

Deno.test("17 no production song-title literals in routing modules", () => {
  const files = [
    "./outreach-decision.ts",
    "./playlist-agent-run.ts",
    "./ops-actors.ts",
    "./pitch-copy-integrity.ts",
    "../execute-pitch/index.ts",
    "../send-pitch-email/index.ts",
  ];
  for (const rel of files) {
    const src = Deno.readTextFileSync(new URL(rel, import.meta.url));
    const noComments = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assertEquals(/Meditate/i.test(noComments), false, `production title literal in ${rel}`);
  }
});

Deno.test("compatible rap DNA + verified rap lane allows", async () => {
  const d = await evaluateOutreachDecision(stubSb(tables()) as never, {
    route: "draft_pitch",
    trackId: TRACK.id,
    playlistId: PLAYLIST_RAP.playlist_id,
  });
  assertEquals(d.allow, true);
  assertEquals(d.code, "allow");
  assertEquals(d.targetClassificationVerified, true);
});
