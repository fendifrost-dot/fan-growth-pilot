import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  PRE_SEND_BLOCKERS,
  PRE_SEND_ROUTE_FRESHNESS_MS,
  evaluatePreSendGate,
  gateEmailDispatch,
  type PreSendInput,
} from "./pre-send-gate.ts";

type Row = Record<string, unknown>;

const NOW = Date.parse("2026-10-26T15:00:00.000Z");
const FRESH = "2026-10-25T15:00:00.000Z";
const STALE = "2026-10-01T15:00:00.000Z";
const SECRET = "UNIQUE_PITCH_BODY_do_not_leak";
const SECRET_SUBJECT = "SECRET_SUBJECT_do_not_leak";

function base(): PreSendInput {
  return {
    channel: "instagram_dm",
    now: NOW,
    copy: { body: SECRET, subject: SECRET_SUBJECT, recipient: "@curator" },
    record: {
      id: "rec-1",
      batch_id: "batch-1",
      track_id: "track-1",
      playlist_target_id: "pl-1",
      queue_state: "APPROVED_FOR_SEND",
      submission_channel: "instagram_dm",
      song_dna_version_id: "dna-1",
      approved_by: "grok_playlist_control",
      packet: {},
    },
    recordStatus: "ok",
    batch: { id: "batch-1", queue_state: "APPROVED_FOR_SEND", approved_by: "grok_playlist_control" },
    batchStatus: "ok",
    track: { id: "track-1", name: "Meditate", approved_song_dna_version_id: "dna-1" },
    dna: {
      id: "dna-1",
      track_id: "track-1",
      approval_state: "approved",
      approved_by: "fendi-user",
      approved_lanes: ["rap_trap_hype"],
      excluded_lanes: ["pop_mainstream"],
      primary_genre: "hip_hop_rap",
    },
    dnaStatus: "ok",
    draftDnaId: "dna-1",
    target: {
      playlist_id: "pl-1",
      is_active: true,
      pitch_status: "ready",
      verification_status: "manually_verified",
      path_verified: true,
      lane: "rap_trap_hype",
      submission_cost: "free",
      last_verified_at: FRESH,
      ig_verified_at: FRESH,
      ig_curator_account: "curator",
      ig_source_evidence: "IG bio says DM for playlist submissions",
      research_context: { identity_resolved: true },
      contact_method: "instagram_dm",
    },
    targetStatus: "ok",
    sendPlaylistId: "pl-1",
    sendTrackId: "track-1",
    clearance: { ok: true, code: "eligible" },
    operator: "clear",
    blocklist: "not_applicable",
  };
}

function input(mutate: (row: PreSendInput) => void): PreSendInput {
  const row = structuredClone(base());
  mutate(row);
  return row;
}

type Spec = { name: string; blockers: string[]; build: () => PreSendInput };

const specs: Spec[] = [
  {
    name: "dna missing",
    blockers: ["dna_missing", "fit_not_explicit"],
    build: () => input((row) => {
      row.track!.approved_song_dna_version_id = null;
      row.dna = null;
      row.dnaStatus = "missing";
      row.draftDnaId = null;
      row.record!.song_dna_version_id = null;
    }),
  },
  {
    name: "dna not approved",
    blockers: ["dna_not_approved", "fit_not_explicit"],
    build: () => input((row) => {
      row.dna!.approval_state = "pending_fendi_review";
    }),
  },
  {
    name: "dna not owner approved",
    blockers: ["dna_not_owner_approved", "fit_not_explicit"],
    build: () => input((row) => {
      row.dna!.approved_by = "";
    }),
  },
  {
    name: "record dna is not the current pointer",
    blockers: ["dna_not_current"],
    build: () => input((row) => {
      row.record!.song_dna_version_id = "dna-old";
    }),
  },
  {
    name: "draft dna is not the current pointer",
    blockers: ["dna_not_current"],
    build: () => input((row) => {
      row.draftDnaId = "dna-old";
    }),
  },
  {
    name: "dna belongs to another track",
    blockers: ["dna_track_mismatch", "fit_not_explicit"],
    build: () => input((row) => {
      row.dna!.track_id = "other-track";
    }),
  },
  {
    name: "dna lookup failed",
    blockers: ["dna_lookup_failed", "fit_not_explicit"],
    build: () => input((row) => {
      row.dna = null;
      row.dnaStatus = "lookup_failed";
    }),
  },
  {
    name: "lane is not an explicit approved lane",
    blockers: ["fit_not_explicit"],
    build: () => input((row) => {
      row.target!.lane = "ambient";
    }),
  },
  {
    name: "empty approved lanes are not an explicit fit",
    blockers: ["fit_not_explicit"],
    build: () => input((row) => {
      row.dna!.approved_lanes = [];
    }),
  },
  {
    name: "missing lane is not an explicit fit",
    blockers: ["fit_not_explicit"],
    build: () => input((row) => {
      row.target!.lane = null;
    }),
  },
  {
    name: "lane excluded",
    blockers: ["fit_lane_excluded"],
    build: () => input((row) => {
      row.target!.lane = "pop_mainstream";
    }),
  },
  {
    name: "identity flag false",
    blockers: ["identity_unresolved"],
    build: () => input((row) => {
      row.target!.research_context = { identity_resolved: false };
    }),
  },
  {
    name: "identity flag missing",
    blockers: ["identity_unresolved"],
    build: () => input((row) => {
      row.target!.research_context = {};
    }),
  },
  {
    name: "identity flag string is not boolean true",
    blockers: ["identity_unresolved"],
    build: () => input((row) => {
      row.target!.research_context = { identity_resolved: "true" };
    }),
  },
  {
    name: "route-only identity",
    blockers: ["identity_unresolved"],
    build: () => input((row) => {
      row.target!.playlist_id = "route-abc";
      row.target!.research_context = { identity_resolved: true, identity_kind: "route_only" };
    }),
  },
  {
    name: "route unverified",
    blockers: ["route_unverified"],
    build: () => input((row) => {
      row.target!.path_verified = false;
    }),
  },
  {
    name: "route evidence text missing",
    blockers: ["route_unverified"],
    build: () => input((row) => {
      row.target!.ig_source_evidence = "";
    }),
  },
  {
    name: "verification time missing",
    blockers: ["route_verification_missing"],
    build: () => input((row) => {
      row.target!.last_verified_at = null;
    }),
  },
  {
    name: "verification time stale",
    blockers: ["route_stale"],
    build: () => input((row) => {
      row.target!.last_verified_at = STALE;
    }),
  },
  {
    name: "channel route evidence missing",
    blockers: ["route_evidence_missing"],
    build: () => input((row) => {
      row.target!.ig_verified_at = null;
    }),
  },
  {
    name: "channel route evidence stale",
    blockers: ["route_evidence_stale"],
    build: () => input((row) => {
      row.target!.ig_verified_at = STALE;
    }),
  },
  {
    name: "web form uses form_verified_at",
    blockers: ["route_evidence_stale"],
    build: () => input((row) => {
      row.channel = "web_form";
      row.record!.submission_channel = "web_form";
      row.target!.contact_method = "web_form";
      row.target!.form_url = "https://curator.example/submit";
      row.target!.form_source_evidence = "submit on curator.example";
      row.target!.form_verified_at = STALE;
    }),
  },
  {
    name: "route hold",
    blockers: ["route_held"],
    build: () => input((row) => {
      row.record!.packet = { route_hold: { reason: "recheck" } };
    }),
  },
  {
    name: "tip is not explicit free terms",
    blockers: ["terms_not_free"],
    build: () => input((row) => {
      row.target!.submission_cost = "tip_appreciated";
    }),
  },
  {
    name: "paid terms",
    blockers: ["terms_paid"],
    build: () => input((row) => {
      row.target!.submission_cost = "paid";
    }),
  },
  {
    name: "invalid owner override does not clear paid terms",
    blockers: ["terms_override_invalid", "terms_paid"],
    build: () => input((row) => {
      row.target!.submission_cost = "paid";
      row.record!.packet = { owner_terms_override: { by: "grok", at: FRESH, reason: "not the owner" } };
    }),
  },
  {
    name: "target missing",
    blockers: ["fit_not_explicit", "target_missing"],
    build: () => input((row) => {
      row.target = null;
      row.targetStatus = "missing";
    }),
  },
  {
    name: "target lookup failed",
    blockers: ["fit_not_explicit", "target_lookup_failed"],
    build: () => input((row) => {
      row.target = null;
      row.targetStatus = "lookup_failed";
    }),
  },
  {
    name: "target inactive",
    blockers: ["target_inactive"],
    build: () => input((row) => {
      row.target!.is_active = false;
    }),
  },
  {
    name: "target activity unknown",
    blockers: ["target_activity_unknown"],
    build: () => input((row) => {
      row.target!.is_active = null;
    }),
  },
  {
    name: "target blocked",
    blockers: ["target_blocked"],
    build: () => input((row) => {
      row.target!.pitch_status = "blocked";
    }),
  },
  {
    name: "blocked operator",
    blockers: ["blocked_operator"],
    build: () => input((row) => {
      row.operator = "blocked";
    }),
  },
  {
    name: "blocked domain",
    blockers: ["blocked_domain"],
    build: () => input((row) => {
      row.blocklist = "blocked";
    }),
  },
  {
    name: "operator clearance unknown",
    blockers: ["operator_clearance_unknown"],
    build: () => input((row) => {
      row.operator = "unknown";
    }),
  },
  {
    name: "blocklist unknown",
    blockers: ["blocklist_unknown"],
    build: () => input((row) => {
      row.blocklist = "unknown";
    }),
  },
  {
    name: "clearance unknown",
    blockers: ["clearance_unknown"],
    build: () => input((row) => {
      row.clearance = null;
    }),
  },
  ...([
    ["identity_required", "clearance_identity_required"],
    ["inactive_target", "clearance_inactive_target"],
    ["paid_curator", "clearance_paid_curator"],
    ["blocked_domain", "clearance_blocked_domain"],
    ["suppressed_curator", "clearance_suppressed_curator"],
    ["cooldown_conflict", "clearance_cooldown_conflict"],
    ["duplicate", "clearance_duplicate"],
  ] as const).map(([code, blocker]) => ({
    name: `clearance ${code}`,
    blockers: [blocker],
    build: () => input((row) => {
      row.clearance = { ok: false, code };
    }),
  })),
  {
    name: "clearance eligible code with ok false is not a pass",
    blockers: ["clearance_blocked"],
    build: () => input((row) => {
      row.clearance = { ok: false, code: "eligible" };
    }),
  },
  {
    name: "unknown clearance code",
    blockers: ["clearance_blocked"],
    build: () => input((row) => {
      row.clearance = { ok: false, code: "nope" };
    }),
  },
  {
    name: "ok true with a non-eligible code is not a pass",
    blockers: ["clearance_cooldown_conflict"],
    build: () => input((row) => {
      row.clearance = { ok: true, code: "cooldown_conflict" };
    }),
  },
  {
    name: "record missing",
    blockers: ["record_missing"],
    build: () => input((row) => {
      row.record = null;
      row.recordStatus = "missing";
    }),
  },
  {
    name: "record ambiguous",
    blockers: ["record_ambiguous"],
    build: () => input((row) => {
      row.record = null;
      row.recordStatus = "ambiguous";
    }),
  },
  {
    name: "record lookup failed",
    blockers: ["record_lookup_failed"],
    build: () => input((row) => {
      row.record = null;
      row.recordStatus = "lookup_failed";
    }),
  },
  {
    name: "record channel unknown",
    blockers: ["record_channel_unknown"],
    build: () => input((row) => {
      row.record!.submission_channel = "";
    }),
  },
  {
    name: "record channel mismatch",
    blockers: ["record_channel_mismatch"],
    build: () => input((row) => {
      row.record!.submission_channel = "email";
    }),
  },
  {
    name: "record not approved for send",
    blockers: ["record_not_approved_for_send"],
    build: () => input((row) => {
      row.record!.queue_state = "GROK_REVIEWED";
    }),
  },
  {
    name: "record approval unnamed",
    blockers: ["record_approval_unnamed"],
    build: () => input((row) => {
      row.record!.approved_by = null;
    }),
  },
  {
    name: "record held",
    blockers: ["record_held"],
    build: () => input((row) => {
      row.record!.packet = { review_defer: { reason: "wait" } };
    }),
  },
  {
    name: "record target mismatch",
    blockers: ["record_target_mismatch"],
    build: () => input((row) => {
      row.record!.playlist_target_id = "pl-other";
    }),
  },
  {
    name: "record track mismatch",
    blockers: ["record_track_mismatch"],
    build: () => input((row) => {
      row.record!.track_id = "track-other";
    }),
  },
  {
    name: "batch missing",
    blockers: ["batch_missing"],
    build: () => input((row) => {
      row.batch = null;
      row.batchStatus = "missing";
    }),
  },
  {
    name: "batch lookup failed",
    blockers: ["batch_lookup_failed"],
    build: () => input((row) => {
      row.batch = null;
      row.batchStatus = "lookup_failed";
    }),
  },
  {
    name: "batch not approved",
    blockers: ["batch_not_approved"],
    build: () => input((row) => {
      row.batch!.queue_state = "GROK_REVIEWED";
    }),
  },
  {
    name: "batch approval unnamed",
    blockers: ["batch_approval_unnamed"],
    build: () => input((row) => {
      row.batch!.approved_by = "  ";
    }),
  },
];

function assertWithheld(decision: ReturnType<typeof evaluatePreSendGate>, expected: string[], label: string) {
  assertEquals(decision.sendable, false, label);
  assertEquals(decision.dispatch, null, label);
  assertEquals(decision.blockers, expected, `${label}: ${JSON.stringify(decision.blockers)}`);
  const blob = JSON.stringify(decision);
  assert(!blob.includes(SECRET), label);
  assert(!blob.includes(SECRET_SUBJECT), label);
  assert(!blob.includes("@curator"), label);
}

for (const spec of specs) {
  Deno.test(`pre-send gate: ${spec.name}`, () => {
    assertWithheld(evaluatePreSendGate(spec.build()), spec.blockers, spec.name);
  });
}

Deno.test("pre-send gate: every blocker code is produced by a negative case", () => {
  const seen = new Set<string>();
  for (const spec of specs) {
    for (const code of evaluatePreSendGate(spec.build()).blockers) seen.add(code);
  }
  for (const code of PRE_SEND_BLOCKERS) assert(seen.has(code), `no case produced ${code}`);
  assertEquals([...seen].sort(), [...PRE_SEND_BLOCKERS].sort());
});

Deno.test("pre-send gate: a fully evidenced instagram row is sendable and returns the body", () => {
  const decision = evaluatePreSendGate(base());
  assertEquals(decision.sendable, true);
  assertEquals(decision.blockers, []);
  assertEquals(decision.warnings, []);
  assertEquals(decision.dispatch, { body: SECRET, subject: SECRET_SUBJECT, recipient: "@curator" });
});

Deno.test("pre-send gate: unknown terms pass with a non-blocking warning and the DM body", () => {
  for (const submission_cost of [null, "", "unknown", "UNKNOWN", "not recorded"]) {
    const decision = evaluatePreSendGate(input((row) => {
      row.target!.submission_cost = submission_cost;
    }));
    assertEquals(decision.sendable, true, String(submission_cost));
    assertEquals(decision.blockers, [], String(submission_cost));
    assertEquals(decision.warnings, ["terms_unconfirmed"], String(submission_cost));
    assertEquals(decision.dispatch?.body, SECRET, String(submission_cost));
  }
});

Deno.test("pre-send gate: free terms pass with no terms warning", () => {
  const decision = evaluatePreSendGate(input((row) => {
    row.target!.submission_cost = "free";
  }));
  assertEquals(decision.sendable, true);
  assertEquals(decision.warnings, []);
  assertEquals(decision.dispatch?.body, SECRET);
});

Deno.test("pre-send gate: known paid and pay-to-submit still block unless Fendi overrides", () => {
  for (const submission_cost of ["paid", "pay-to-submit", "pay_to_submit"]) {
    const blocked = evaluatePreSendGate(input((row) => {
      row.target!.submission_cost = submission_cost;
    }));
    assertEquals(blocked.sendable, false, submission_cost);
    assertEquals(blocked.blockers, ["terms_paid"], submission_cost);
    assertEquals(blocked.warnings, [], submission_cost);
    assertEquals(blocked.dispatch, null, submission_cost);
    assert(!JSON.stringify(blocked).includes(SECRET), submission_cost);

    const cleared = evaluatePreSendGate(input((row) => {
      row.target!.submission_cost = submission_cost;
      row.record!.packet = {
        owner_terms_override: { by: "fendi", at: FRESH, reason: "owner allowed this paid list" },
      };
    }));
    assertEquals(cleared.sendable, true, submission_cost);
    assertEquals(cleared.blockers, [], submission_cost);
    assertEquals(cleared.warnings, [], submission_cost);
    assertEquals(cleared.dispatch?.body, SECRET, submission_cost);
  }
});

Deno.test("pre-send gate: email does not require an Instagram evidence stamp", () => {
  const decision = evaluatePreSendGate(input((row) => {
    row.channel = "email";
    row.record!.submission_channel = "email";
    row.target!.contact_method = "email";
    row.target!.curator_email = "curator@example.com";
    row.target!.ig_verified_at = null;
    row.blocklist = "clear";
    row.copy = { body: SECRET, subject: SECRET_SUBJECT, recipient: "curator@example.com" };
  }));
  assertEquals(decision.blockers, [], JSON.stringify(decision.blockers));
  assertEquals(decision.sendable, true);
  assertEquals(decision.dispatch?.body, SECRET);
});

Deno.test("pre-send gate: a stamp exactly 7 days old is fresh and one millisecond older is stale", () => {
  assertEquals(PRE_SEND_ROUTE_FRESHNESS_MS, 7 * 24 * 60 * 60 * 1000);
  const exact = new Date(NOW - PRE_SEND_ROUTE_FRESHNESS_MS).toISOString();
  const fresh = evaluatePreSendGate(input((row) => {
    row.target!.last_verified_at = exact;
    row.target!.ig_verified_at = exact;
  }));
  assertEquals(fresh.sendable, true, JSON.stringify(fresh.blockers));

  const older = new Date(NOW - PRE_SEND_ROUTE_FRESHNESS_MS - 1).toISOString();
  const stale = evaluatePreSendGate(input((row) => {
    row.target!.last_verified_at = older;
  }));
  assertEquals(stale.blockers, ["route_stale"]);
  assertEquals(stale.dispatch, null);
});

Deno.test("pre-send gate: a recorded Fendi terms override clears paid terms and nothing else", () => {
  const paid = evaluatePreSendGate(input((row) => {
    row.target!.submission_cost = "paid";
    row.target!.research_context = {
      identity_resolved: true,
      owner_terms_override: { by: "Fendi", at: FRESH, reason: "owner allowed this paid list" },
    };
  }));
  assertEquals(paid.blockers, [], JSON.stringify(paid.blockers));
  assertEquals(paid.sendable, true);

  const free = evaluatePreSendGate(input((row) => {
    row.record!.packet = { owner_terms_override: { by: "grok" } };
  }));
  assertEquals(free.sendable, true, JSON.stringify(free.blockers));
});

Deno.test("pre-send gate: audit shape (review record, unnamed approval, unknown terms) is not sendable", () => {
  const decision = evaluatePreSendGate(input((row) => {
    row.channel = "email";
    row.record!.submission_channel = "email";
    row.record!.queue_state = "AWAITING_GROK_REVIEW";
    row.record!.approved_by = null;
    row.target!.contact_method = "email";
    row.target!.curator_email = "curator@example.com";
    row.target!.submission_cost = null;
    row.target!.ig_verified_at = null;
    row.blocklist = "clear";
  }));
  assertEquals(decision.blockers, [
    "record_not_approved_for_send",
    "record_approval_unnamed",
  ]);
  assertEquals(decision.warnings, ["terms_unconfirmed"]);
  assertEquals(decision.sendable, false);
  assertEquals(decision.dispatch, null);
  assert(!JSON.stringify(decision).includes(SECRET));
});

Deno.test("pre-send freshness constant matches the discovery route-proof window", async () => {
  const src = await Deno.readTextFile(new URL("./playlist-discovery-mcp.ts", import.meta.url));
  assert(src.includes("export const ROUTE_PROOF_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;"));
  assertEquals(PRE_SEND_ROUTE_FRESHNESS_MS, 7 * 24 * 60 * 60 * 1000);
});

Deno.test("pre-send gate module does not write", async () => {
  const src = await Deno.readTextFile(new URL("./pre-send-gate.ts", import.meta.url));
  for (const writer of [".insert(", ".update(", ".upsert(", ".delete("]) {
    assertEquals(src.includes(writer), false, writer);
  }
});

type Memory = Record<string, Row[]>;

function memorySb(tables: Memory, rpc?: (fn: string, args: Row) => { data: unknown; error: { message?: string } | null }) {
  // deno-lint-ignore no-explicit-any
  const sb: any = {
    from(table: string) {
      const filters: ((row: Row) => boolean)[] = [];
      let single = false;
      // deno-lint-ignore no-explicit-any
      const chain: any = {
        select: () => chain,
        eq: (key: string, value: unknown) => {
          filters.push((row) => String(row[key] ?? "") === String(value ?? ""));
          return chain;
        },
        in: (key: string, values: unknown[]) => {
          const set = new Set((values ?? []).map((value) => String(value)));
          filters.push((row) => set.has(String(row[key] ?? "")));
          return chain;
        },
        is: () => chain,
        not: (key: string, op: string, value: unknown) => {
          if (op === "is" && value === null) {
            filters.push((row) => row[key] != null && String(row[key]).trim() !== "");
          }
          return chain;
        },
        order: () => chain,
        limit: () => chain,
        range: () => chain,
        maybeSingle: () => {
          single = true;
          return chain;
        },
        then: (resolve: (value: unknown) => void) => {
          const data = (tables[table] ?? []).filter((row) => filters.every((fn) => fn(row)));
          resolve(single ? { data: data[0] ?? null, error: null } : { data, error: null });
        },
      };
      return chain;
    },
    rpc(fn: string, args: Row) {
      return Promise.resolve(rpc ? rpc(fn, args) : { data: { ok: true, code: "eligible" }, error: null });
    },
  };
  return sb;
}

function emailTarget(extra: Row = {}): Row {
  return {
    playlist_id: "pl-1",
    playlist_name: "Lyrical Rap",
    is_active: true,
    pitch_status: "ready",
    verification_status: "manually_verified",
    path_verified: true,
    lane: "rap_trap_hype",
    submission_cost: "free",
    last_verified_at: FRESH,
    curator_email: "curator@example.com",
    contact_method: "email",
    research_context: { identity_resolved: true },
    ...extra,
  };
}

function emailTables(extra: Partial<Memory> = {}): Memory {
  return {
    agh_handoff_records: [{
      id: "rec-1",
      batch_id: "batch-1",
      track_id: "track-1",
      playlist_target_id: "pl-1",
      queue_state: "APPROVED_FOR_SEND",
      submission_channel: "email",
      song_dna_version_id: "dna-1",
      approved_by: "grok_playlist_control",
      packet: {},
      outreach_draft_id: "draft-1",
    }],
    agh_handoff_batches: [{ id: "batch-1", queue_state: "APPROVED_FOR_SEND", approved_by: "grok_playlist_control" }],
    tracks: [{ id: "track-1", name: "Meditate", approved_song_dna_version_id: "dna-1" }],
    song_dna_versions: [{
      id: "dna-1",
      track_id: "track-1",
      approval_state: "approved",
      approved_by: "fendi-user",
      approved_lanes: ["rap_trap_hype"],
      excluded_lanes: [],
      primary_genre: "hip_hop_rap",
    }],
    playlist_targets: [emailTarget()],
    domain_blocklist: [],
    ...extra,
  };
}

const emailDraft: Row = {
  id: "draft-1",
  playlist_id: "pl-1",
  track_id: "track-1",
  song_dna_version_id: "dna-1",
  channel: "email",
  body: SECRET,
  subject: SECRET_SUBJECT,
  recipient: "curator@example.com",
  metadata: { handoff_record_id: "rec-1" },
};

Deno.test("gateEmailDispatch: the 2026-10-26 audit shape is refused with no copy", async () => {
  const tables = emailTables();
  (tables.agh_handoff_records[0] as Row).queue_state = "AWAITING_GROK_REVIEW";
  (tables.agh_handoff_records[0] as Row).approved_by = null;
  const target = emailTarget({ submission_cost: null });
  const decision = await gateEmailDispatch(memorySb(tables), { draft: emailDraft, target, now: NOW });
  assertEquals(decision.blockers, [
    "record_not_approved_for_send",
    "record_approval_unnamed",
  ]);
  assertEquals(decision.warnings, ["terms_unconfirmed"]);
  assertEquals(decision.sendable, false);
  assertEquals(decision.dispatch, null);
  assert(!JSON.stringify(decision).includes(SECRET));
  assert(!JSON.stringify(decision).includes(SECRET_SUBJECT));
});

Deno.test("gateEmailDispatch: a fully cleared email draft is sendable", async () => {
  const decision = await gateEmailDispatch(memorySb(emailTables()), {
    draft: emailDraft,
    target: emailTarget(),
    now: NOW,
  });
  assertEquals(decision.blockers, [], JSON.stringify(decision.blockers));
  assertEquals(decision.warnings, []);
  assertEquals(decision.sendable, true);
  assertEquals(decision.dispatch?.body, SECRET);
});

Deno.test("gateEmailDispatch: blocked operator, blocked domain, cooldown, and a missing record", async () => {
  const operatorTables = emailTables({
    playlist_targets: [
      emailTarget({ ig_curator_account: "colonizehandle" }),
      {
        playlist_id: "pl-anchor",
        operator_group_id: "colonizemedia",
        pitch_status: "blocked",
        ig_curator_account: "colonizehandle",
        is_active: false,
      },
    ],
  });
  const operator = await gateEmailDispatch(memorySb(operatorTables), {
    draft: emailDraft,
    target: emailTarget({ ig_curator_account: "colonizehandle" }),
    now: NOW,
  });
  assertEquals(operator.blockers, ["blocked_operator"]);
  assertEquals(operator.dispatch, null);

  const domainTables = emailTables({ domain_blocklist: [{ domain: "spam.test" }] });
  const domain = await gateEmailDispatch(memorySb(domainTables), {
    draft: emailDraft,
    target: emailTarget({ curator_email: "a@spam.test" }),
    now: NOW,
  });
  assertEquals(domain.blockers, ["blocked_domain"], JSON.stringify(domain.blockers));
  assertEquals(domain.dispatch, null);

  const cooled = await gateEmailDispatch(memorySb(emailTables(), () => ({
    data: { ok: false, code: "cooldown_conflict" },
    error: null,
  })), { draft: emailDraft, target: emailTarget(), now: NOW });
  assertEquals(cooled.blockers, ["clearance_cooldown_conflict"]);
  assertEquals(cooled.dispatch, null);

  const missing = await gateEmailDispatch(memorySb(emailTables({ agh_handoff_records: [] })), {
    draft: { ...emailDraft, metadata: {} },
    target: emailTarget(),
    now: NOW,
  });
  assertEquals(missing.sendable, false);
  assert(missing.blockers.includes("record_missing"), JSON.stringify(missing.blockers));
  assertEquals(missing.dispatch, null);
  assert(!JSON.stringify(missing).includes(SECRET));
});

Deno.test("WIRING: execute-pitch and send-pitch-email call the gate before any Resend send", async () => {
  const exec = await Deno.readTextFile(new URL("../execute-pitch/index.ts", import.meta.url));
  const send = await Deno.readTextFile(new URL("../send-pitch-email/index.ts", import.meta.url));
  const queue = await Deno.readTextFile(new URL("./ig-dm-send-queue.ts", import.meta.url));

  const execBranch = exec.slice(exec.lastIndexOf('if (method === "email")'));
  const execGate = execBranch.indexOf("gateEmailDispatch(");
  const execSend = execBranch.indexOf("handleEmailPitch(");
  assert(execGate > -1 && execSend > execGate, "execute-pitch must gate before handleEmailPitch");
  assert(execBranch.indexOf("if (!preSend.sendable)") < execSend);
  assert(!execBranch.slice(execGate, execSend).includes("testMode"), "test_mode must not wrap the gate");
  assert(exec.includes("https://api.resend.com/emails"));
  assert(exec.indexOf("gateEmailDispatch(") < exec.indexOf("https://api.resend.com/emails"));

  const sendGate = send.indexOf("gateEmailDispatch(");
  const sendResend = send.indexOf("sendResendEmail(");
  assert(sendGate > -1 && sendResend > sendGate, "send-pitch-email must gate before Resend");
  assert(send.indexOf('code: "pre_send_blocked"') > -1);

  assert(queue.includes("decideHandoffSends("));
  assert(queue.includes("dm_body: sendable ? body : null"));
  assert(queue.includes("approved_song_dna_version_id"));
  assert(queue.includes("ig_verified_at"));
  assert(queue.includes("submission_cost"));
  assert(!queue.includes("sendable: blockers.length === 0"));
});
