/**
 * Authoritative split-sheet rights stack — validation, versioning, auth matrix,
 * delivery policy, sync gate provenance, and RPC contract documentation.
 *
 * Database-backed when SUPABASE_URL + service key exist; otherwise in-memory mocks.
 */
import {
  assert,
  assertEquals,
  assertFalse,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  can,
  isFendiReserved,
  resolveOpsActor,
  stripSpoofedAttribution,
} from "./ops-actors.ts";
import { ACTION_SPEC, requiredCapabilityForAction } from "./outreach-auth.ts";
import { evaluateSyncEligibility } from "./sync-eligibility.ts";
import { PLAYLIST_DISCOVERY_TOOLS } from "./playlist-discovery-mcp.ts";
import type { Actor } from "./outreach-auth.ts";
import {
  RIGHTS_DOCUMENTS_BUCKET,
  RIGHTS_DOCUMENTS_BUCKET_IS_PUBLIC,
  SPLIT_SHEET_RPC_CONTRACT,
  assertSplitSheetMutable,
  deprecatedUpdateSplitSheetContributors,
  isDeliverableSplitSheetStatus,
  isSecureLinkExpired,
  mockCreateSplitSheetVersion,
  recordRightsAuditEvent,
  sanitizeSplitSheetBody,
  secureLinkExpiresAt,
  shouldAttachSplitSheetToInitialPitch,
  splitsReadyPassesSyncGate,
  validateContributorSetLocal,
  type RightsAuditEvent,
  type SplitSheetRow,
} from "./split-sheets-authoritative.ts";

function user(userId: string, isAdmin = true): Actor {
  return { kind: "user", userId, isAdmin };
}

function req(headers: Record<string, string> = {}): Request {
  return new Request("https://example.test", { headers });
}

function withEnv(vars: Record<string, string>, fn: () => void) {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = Deno.env.get(k);
    Deno.env.set(k, v);
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v == null) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

const goodComposition = [
  { legal_name: "Writer A", role: "writer", split_percent: 60 },
  { legal_name: "Writer B", role: "composer", split_percent: 40 },
];

Deno.test("1. validateContributorSetLocal rejects bad percents and non-100 totals", () => {
  const badPct = validateContributorSetLocal([
    { legal_name: "A", role: "writer", split_percent: 150 },
  ]);
  assertFalse(badPct.ok);
  assert(badPct.errors.includes("composition_percent_out_of_range"));
  assert(badPct.errors.includes("composition_total_must_equal_100"));

  const badTotal = validateContributorSetLocal([
    { legal_name: "A", role: "writer", split_percent: 40 },
    { legal_name: "B", role: "writer", split_percent: 40 },
  ]);
  assertFalse(badTotal.ok);
  assert(badTotal.errors.includes("composition_total_must_equal_100"));

  const ok = validateContributorSetLocal(goodComposition, [
    { legal_name: "Label LLC", ownership_percent: 100 },
  ]);
  assertEquals(ok.ok, true);
  assertEquals(ok.composition_total, 100);
  assertEquals(ok.master_total, 100);
});

Deno.test("2. Failed replacement preserves prior version (validation_failed)", () => {
  const prior: SplitSheetRow = {
    id: "sheet-v1",
    track_id: "track-1",
    version_number: 1,
    status: "draft",
    is_current: true,
    composition: goodComposition,
  };
  const store = { sheets: [prior] };
  const snapshot = structuredClone(store.sheets);

  const result = mockCreateSplitSheetVersion(store, {
    track_id: "track-1",
    composition: [{ legal_name: "A", role: "writer", split_percent: 30 }],
  });
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.code, "validation_failed");
  assertEquals(store.sheets.length, 1);
  assertEquals(store.sheets[0].id, snapshot[0].id);
  assertEquals(store.sheets[0].is_current, true);
  assertEquals(store.sheets[0].composition, goodComposition);
});

Deno.test("3. Finalized versions cannot be edited in place (410/immutable)", () => {
  const immutable = assertSplitSheetMutable({ status: "final" });
  assertEquals(immutable.ok, false);
  if (!immutable.ok) {
    assertEquals(immutable.status, 410);
    assertEquals(immutable.code, "immutable");
  }
  const superseded = assertSplitSheetMutable({ status: "superseded" });
  assertEquals(superseded.ok, false);
  assertEquals(assertSplitSheetMutable({ status: "draft" }).ok, true);

  const gone = deprecatedUpdateSplitSheetContributors();
  assertEquals(gone.status, 410);
  assertEquals(gone.data.code, "gone");
});

Deno.test("4. Corrections create new version via RPC mock", () => {
  const store = {
    sheets: [
      {
        id: "sheet-v1",
        track_id: "track-1",
        version_number: 1,
        status: "final",
        is_current: true,
        composition: goodComposition,
      } satisfies SplitSheetRow,
    ],
  };
  const result = mockCreateSplitSheetVersion(store, {
    track_id: "track-1",
    composition: [
      { legal_name: "Writer A", role: "writer", split_percent: 50 },
      { legal_name: "Writer B", role: "composer", split_percent: 50 },
    ],
  });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.version_number, 2);
    assertEquals(result.previous_sheet_id, "sheet-v1");
  }
  assertEquals(store.sheets.length, 2);
  const old = store.sheets.find((s) => s.id === "sheet-v1")!;
  assertEquals(old.is_current, false);
  assertEquals(old.status, "superseded");
  const neu = store.sheets.find((s) => s.is_current)!;
  assertEquals(neu.version_number, 2);
  assertEquals(neu.status, "draft");
});

Deno.test("5. Caller-supplied approval identity rejected/stripped", () => {
  const cleaned = sanitizeSplitSheetBody({
    split_sheet_id: "s1",
    approved_by: "attacker",
    fendi_approved_by: "spoof",
    finalized_by: "nope",
    approval_identity: "forged",
    notes: "keep",
  });
  assertEquals(cleaned.split_sheet_id, "s1");
  assertEquals(cleaned.notes, "keep");
  assertEquals(cleaned.approved_by, undefined);
  assertEquals(cleaned.fendi_approved_by, undefined);
  assertEquals(cleaned.finalized_by, undefined);
  assertEquals(cleaned.approval_identity, undefined);

  const also = stripSpoofedAttribution({ generated_by: "x", track_id: "t" });
  assertEquals(also.generated_by, undefined);
  assertEquals(also.track_id, "t");
});

Deno.test("6. Ordinary human_admin cannot finalize", () => {
  withEnv({ ARTIST_USER_ID: "fendi-exact-id" }, () => {
    const admin = resolveOpsActor(user("other-admin"), null);
    assertEquals(admin.kind, "human_admin");
    assertEquals(can(admin, "finalize_split_sheet"), false);
    assertEquals(can(admin, "authorize_split_sheet_delivery"), false);
    assertEquals(can(admin, "draft_split_sheet"), true);
    assertEquals(can(admin, "manage_split_sheet_evidence"), true);
    assert(isFendiReserved("finalize_split_sheet"));
    // Grok may request delivery auth; granting remains Fendi-only in the delivery handler.
    assertFalse(isFendiReserved("authorize_split_sheet_delivery"));
  });
});

Deno.test("7. Claude cannot finalize or deliver", () => {
  withEnv({ CLAUDE_AGENT_SECRET: "claude-secret" }, () => {
    const actor = resolveOpsActor(null, req({ "x-claude-agent-secret": "claude-secret" }));
    assertEquals(actor.kind, "claude");
    assertEquals(can(actor, "draft_split_sheet"), true);
    assertEquals(can(actor, "read_split_sheets"), true);
    assertEquals(can(actor, "finalize_split_sheet"), false);
    assertEquals(can(actor, "deliver_split_sheet"), false);
    assertEquals(can(actor, "authorize_split_sheet_delivery"), false);
  });
  withEnv({ CLAUDE_SYNC_DISCOVERY_SECRET: "sync-secret" }, () => {
    const sd = resolveOpsActor(null, req({ "x-claude-sync-discovery-secret": "sync-secret" }));
    assertEquals(sd.kind, "claude_sync_discovery");
    assertEquals(can(sd, "draft_split_sheet"), true);
    assertEquals(can(sd, "finalize_split_sheet"), false);
    assertEquals(can(sd, "deliver_split_sheet"), false);
  });
});

Deno.test("8. Grok cannot edit shares and cannot deliver draft/superseded", () => {
  withEnv({ GROK_PLAYLIST_CONTROL_SECRET: "grok-secret" }, () => {
    const grok = resolveOpsActor(null, req({ "x-grok-playlist-control-secret": "grok-secret" }));
    assertEquals(grok.kind, "grok_playlist_control");
    assertEquals(can(grok, "draft_split_sheet"), false);
    assertEquals(can(grok, "read_split_sheets"), true);
    assertEquals(can(grok, "deliver_split_sheet"), true);
    assertEquals(can(grok, "authorize_split_sheet_delivery"), true);
    assertEquals(can(grok, "finalize_split_sheet"), false);
    assertEquals(requiredCapabilityForAction("create_split_sheet_version"), "draft_split_sheet");
    assertFalse(can(grok, requiredCapabilityForAction("create_split_sheet_version")!));

    assertFalse(isDeliverableSplitSheetStatus("draft"));
    assertFalse(isDeliverableSplitSheetStatus("superseded"));
    assert(isDeliverableSplitSheetStatus("final"));
    assert(isDeliverableSplitSheetStatus("approved"));
  });
});

Deno.test("9. shouldAttachSplitSheetToInitialPitch === false", () => {
  assertEquals(shouldAttachSplitSheetToInitialPitch(), false);
  assertEquals(
    shouldAttachSplitSheetToInitialPitch({ allow_auto_attach_on_initial_pitch: true }),
    false,
  );
  assertEquals(
    shouldAttachSplitSheetToInitialPitch({ allow_auto_attach_on_initial_pitch: false }),
    false,
  );
});

Deno.test("10. Secure link expiry helper / no public bucket flag", () => {
  assertEquals(RIGHTS_DOCUMENTS_BUCKET, "rights-documents");
  assertEquals(RIGHTS_DOCUMENTS_BUCKET_IS_PUBLIC, false);
  const now = Date.parse("2026-09-11T12:00:00.000Z");
  const exp = secureLinkExpiresAt(now, 900);
  assertEquals(exp.toISOString(), "2026-09-11T12:15:00.000Z");
  assertFalse(isSecureLinkExpired(exp.toISOString(), now + 60_000));
  assert(isSecureLinkExpired(exp.toISOString(), now + 901_000));
  assert(isSecureLinkExpired(null, now));
});

Deno.test("11. Audit events recorded on view/download/delivery (mock)", () => {
  const sink: RightsAuditEvent[] = [];
  recordRightsAuditEvent(sink, {
    event_kind: "view",
    track_id: "t1",
    split_sheet_id: "s1",
    actor_kind: "human_admin",
    actor_label: "human_admin",
  });
  recordRightsAuditEvent(sink, {
    event_kind: "download",
    track_id: "t1",
    split_sheet_id: "s1",
    actor_kind: "fendi",
    actor_label: "fendi",
    document_hash: "abc",
  });
  recordRightsAuditEvent(sink, {
    event_kind: "delivery",
    track_id: "t1",
    split_sheet_id: "s1",
    actor_kind: "grok_playlist_control",
    actor_label: "grok_playlist_control",
    detail: { recipient: "sync@example.com" },
  });
  assertEquals(sink.length, 3);
  assertEquals(sink.map((e) => e.event_kind), ["view", "download", "delivery"]);
});

Deno.test("12. Sync eligibility: unverified_legacy blocks; authoritative_final passes splits gate", () => {
  assertFalse(
    splitsReadyPassesSyncGate({
      splits_ready: true,
      splits_ready_source: "unverified_legacy",
    }),
  );
  assert(
    splitsReadyPassesSyncGate({
      splits_ready: true,
      splits_ready_source: "authoritative_final",
    }),
  );

  const dna = {
    id: "dna-1",
    approval_state: "approved",
    sample_declaration: "no",
    sync_recommendation: "approved",
    payload: {},
  };
  const base = {
    id: "track-1",
    approved_song_dna_version_id: "dna-1",
    has_sample: "no",
    assets_ready: true,
    publishing_ready: true,
    unresolved_rights_exception: false,
    sample_declaration_approved_at: "2026-09-01T00:00:00Z",
    sample_declaration_approved_by: "fendi",
    sync_approved_at: "2026-09-01T00:00:00Z",
    sync_approved_by: "fendi",
  };

  const legacy = evaluateSyncEligibility({
    track: { ...base, splits_ready: true, splits_ready_source: "unverified_legacy" },
    dna,
    privateLicenseVerified: false,
  });
  assertEquals(legacy.eligible, false);
  assert(legacy.blockers.includes("required_splits"));

  const authoritative = evaluateSyncEligibility({
    track: { ...base, splits_ready: true, splits_ready_source: "authoritative_final" },
    dna,
    privateLicenseVerified: false,
  });
  assertFalse(authoritative.blockers.includes("required_splits"));
  assertEquals(authoritative.eligible, true);
});

Deno.test("13. Playlist discovery tools still listed / sync stack playlist paths untouched", () => {
  assert(Array.isArray(PLAYLIST_DISCOVERY_TOOLS));
  assert(PLAYLIST_DISCOVERY_TOOLS.length >= 1);
  assert(PLAYLIST_DISCOVERY_TOOLS.includes("get_playlist_discovery_work"));
});

Deno.test("ACTION_SPEC maps split-sheet actions to expected capabilities", () => {
  assertEquals(requiredCapabilityForAction("list_split_sheets"), "read_split_sheets");
  assertEquals(requiredCapabilityForAction("create_split_sheet_version"), "draft_split_sheet");
  assertEquals(requiredCapabilityForAction("finalize_split_sheet"), "finalize_split_sheet");
  assertEquals(
    requiredCapabilityForAction("deliver_split_sheet_to_sync_contact"),
    "deliver_split_sheet",
  );
  assertEquals(
    requiredCapabilityForAction("request_split_sheet_delivery_authorization"),
    "authorize_split_sheet_delivery",
  );
  assertEquals(
    requiredCapabilityForAction("upload_split_sheet_evidence"),
    "manage_split_sheet_evidence",
  );
  assertEquals(
    requiredCapabilityForAction("update_split_sheet_contributors"),
    "draft_split_sheet",
  );
  assertEquals(ACTION_SPEC.finalize_split_sheet.cls, "capability");
  assertEquals(SPLIT_SHEET_RPC_CONTRACT.finalize_split_sheet_version.fendi_only, true);
  assertEquals(
    SPLIT_SHEET_RPC_CONTRACT.create_split_sheet_version.validation_failed_preserves_prior,
    true,
  );
});

Deno.test("Fendi holds full split-sheet capability set", () => {
  withEnv({ ARTIST_USER_ID: "fendi-exact-id" }, () => {
    const fendi = resolveOpsActor(user("fendi-exact-id"), null);
    assertEquals(fendi.kind, "fendi");
    for (const cap of [
      "draft_split_sheet",
      "read_split_sheets",
      "manage_split_sheet_evidence",
      "finalize_split_sheet",
      "deliver_split_sheet",
      "authorize_split_sheet_delivery",
      "read_split_sheet_deliveries",
    ] as const) {
      assertEquals(can(fendi, cap), true, `fendi must have ${cap}`);
    }
  });
});
