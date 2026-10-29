import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  IG_RECEIPT_ACTION,
  IG_SEND_OWNER,
  igHandleOf,
  igSendQueueReadable,
  listIgDmSendQueue,
  pickSendDraft,
  sendQueueRow,
} from "./ig-dm-send-queue.ts";
import type { PreSendDecision } from "./pre-send-gate.ts";
import { resolveOpsActor } from "./ops-actors.ts";
import { authorizeAction, MUSE_IG_ACTIONS } from "./outreach-auth.ts";

type Row = Record<string, unknown>;

const MUSE = "muse-receipt-secret";
const GROK = "grok-control-secret";
const DISCOVERY = "pd-secret-narrow-only";

function req(headers: Record<string, string>): Request {
  return new Request("https://example.test/", { method: "POST", headers });
}

function withEnv(vars: Record<string, string>, fn: () => void | Promise<void>) {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = Deno.env.get(k);
    Deno.env.set(k, v);
  }
  const restore = () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  };
  const out = fn();
  if (out instanceof Promise) return out.finally(restore);
  restore();
  return out;
}

const ENV = {
  MUSE_IG_RECEIPT_SECRET: MUSE,
  GROK_PLAYLIST_CONTROL_SECRET: GROK,
  CLAUDE_PLAYLIST_DISCOVERY_SECRET: DISCOVERY,
  FANFUEL_HUB_KEY: "hub-service-key",
  CLAUDE_AGENT_SECRET: "claude-agent-secret",
  CLAUDE_SYNC_DISCOVERY_SECRET: "sync-secret",
  OUTREACH_SCHEDULER_SECRET: "scheduler-secret",
};

function museActor() {
  return resolveOpsActor(null, req({ "x-muse-ig-receipt-secret": MUSE }));
}
function grokActor() {
  return resolveOpsActor(null, req({ "x-grok-playlist-control-secret": GROK }));
}
function discoveryActor() {
  return resolveOpsActor(null, req({ "x-claude-playlist-discovery-secret": DISCOVERY }));
}

/** Minimal in-memory client: eq / in / is / not filters, select with count, rpc. */
function stubSb(tables: Record<string, Row[]>, policies: Record<string, Row> = {}) {
  // deno-lint-ignore no-explicit-any
  const sb: any = {
    from(table: string) {
      const filters: ((r: Row) => boolean)[] = [];
      let sortBy: { col: string; asc: boolean } | null = null;
      let single = false;
      const rows = () => (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      // deno-lint-ignore no-explicit-any
      const chain: any = {
        select: () => chain,
        eq: (k: string, v: unknown) => {
          filters.push((r) => String(r[k] ?? "") === String(v ?? ""));
          return chain;
        },
        in: (k: string, vals: unknown[]) => {
          const set = new Set((vals ?? []).map((v) => String(v)));
          filters.push((r) => set.has(String(r[k] ?? "")));
          return chain;
        },
        is: (k: string, v: unknown) => {
          if (v === null) filters.push((r) => r[k] == null || String(r[k]).trim() === "");
          return chain;
        },
        not: (k: string, op: string, v: unknown) => {
          if (op === "is" && v === null) filters.push((r) => r[k] != null && String(r[k]).trim() !== "");
          return chain;
        },
        order: (col: string, opts?: { ascending?: boolean }) => {
          sortBy = { col, asc: opts?.ascending !== false };
          return chain;
        },
        limit: () => chain,
        range: () => chain,
        maybeSingle: () => {
          single = true;
          return chain;
        },
        then: (resolve: (v: unknown) => void) => {
          const data = rows();
          if (sortBy) {
            const { col, asc } = sortBy;
            data.sort((a, b) => String(a[col] ?? "").localeCompare(String(b[col] ?? "")) * (asc ? 1 : -1));
          }
          resolve(single
            ? { data: data[0] ?? null, error: null }
            : { data, error: null, count: data.length });
        },
      };
      return chain;
    },
    rpc(fn: string, args: Row) {
      if (fn !== "agh_contact_policy") {
        return Promise.resolve({ data: null, error: { message: "unknown rpc" } });
      }
      const key = String(args?.p_target ?? "");
      const policy = policies[key] ?? { ok: true, code: "eligible" };
      return Promise.resolve({ data: policy, error: null });
    },
  };
  return sb;
}

const NOW = Date.parse("2026-10-26T15:00:00.000Z");
const FRESH = "2026-10-25T15:00:00.000Z";
const STALE = "2026-10-01T15:00:00.000Z";
const POSITIVE_BODY = "Hi Akhil, Meditate for Lyrical Rap. Stream: https://open.spotify.com/track/x";
const STALE_BODY = "STALE_ROUTE_BODY_SHOULD_NOT_LEAK";
const BARE_BODY = "BARE_DRAFT_BODY_SHOULD_NOT_LEAK";

function readyTarget(playlistId: string, handle: string, extra: Row = {}): Row {
  return {
    playlist_id: playlistId,
    playlist_name: "Lyrical Rap",
    ig_curator_account: handle,
    curator_instagram: handle,
    is_active: true,
    pitch_status: "ready",
    verification_status: "manually_verified",
    path_verified: true,
    lane: "rap_trap_hype",
    submission_cost: "free",
    last_verified_at: FRESH,
    ig_verified_at: FRESH,
    ig_source_evidence: "IG bio says DM for playlist submissions",
    research_context: { identity_resolved: true },
    contact_method: "instagram_dm",
    ...extra,
  };
}

function readyDraft(id: string, playlistId: string, handle: string, recordId: string, extra: Row = {}): Row {
  return {
    id,
    track_id: "track-med",
    playlist_id: playlistId,
    channel: "instagram_dm",
    status: "approved",
    body: POSITIVE_BODY,
    recipient: `@${handle}`,
    generated_by: "claude_playlist_discovery",
    approved_by: "grok_playlist_control",
    approved_at: FRESH,
    generated_at: FRESH,
    song_dna_version_id: "dna-med",
    metadata: { handoff_record_id: recordId },
    ...extra,
  };
}

function readyRecord(id: string, playlistId: string, draftId: string, updatedAt: string, extra: Row = {}): Row {
  return {
    id,
    batch_id: "b1",
    track_id: "track-med",
    playlist_target_id: playlistId,
    queue_state: "APPROVED_FOR_SEND",
    submission_channel: "instagram_dm",
    song_dna_version_id: "dna-med",
    approved_by: "grok_playlist_control",
    outreach_draft_id: draftId,
    packet: {},
    submitted_at: null,
    updated_at: updatedAt,
    ...extra,
  };
}

function fixture(): Record<string, Row[]> {
  return {
    tracks: [
      { id: "track-med", name: "Meditate", approved_song_dna_version_id: "dna-med" },
      { id: "track-bare", name: "Bare", approved_song_dna_version_id: null },
    ],
    song_dna_versions: [{
      id: "dna-med",
      track_id: "track-med",
      approval_state: "approved",
      approved_by: "fendi-user",
      approved_lanes: ["rap_trap_hype"],
      excluded_lanes: ["pop_mainstream"],
      primary_genre: "hip_hop_rap",
    }],
    agh_handoff_batches: [
      { id: "b1", queue_state: "APPROVED_FOR_SEND", approved_by: "grok_playlist_control" },
    ],
    domain_blocklist: [{ domain: "spam.test" }],
    playlist_targets: [
      readyTarget("pl-a", "akhilsagar", { playlist_name: "Lyrical Rap" }),
      readyTarget("pl-b", "linmusiclist", { playlist_name: "Rap & Trap" }),
      readyTarget("pl-c", "oldhandle", { playlist_name: "Old List", ig_verified_at: STALE }),
      readyTarget("pl-terms", "terms_handle", { submission_cost: "unknown" }),
      readyTarget("pl-op", "colonizehandle"),
      readyTarget("pl-domain", "domain_handle", { curator_email: "a@spam.test" }),
      readyTarget("pl-cool", "cool_handle"),
      // Draft and an active flag only — the old sendable shape.
      { playlist_id: "pl-bare", playlist_name: "Bare List", ig_curator_account: "barehandle", is_active: true },
      // Sibling row that anchors a blocked operator. Not itself a send target.
      {
        playlist_id: "pl-anchor",
        operator_group_id: "colonizemedia",
        pitch_status: "blocked",
        ig_curator_account: "colonizehandle",
        is_active: false,
        playlist_name: "Colonize",
      },
    ],
    outreach_drafts: [
      readyDraft("draft-a", "pl-a", "akhilsagar", "rec-a"),
      readyDraft("draft-b", "pl-b", "linmusiclist", "rec-b", { status: "pending", body: "not approved yet" }),
      readyDraft("draft-c", "pl-c", "oldhandle", "rec-c", { body: STALE_BODY, recipient: "oldhandle" }),
      readyDraft("draft-terms", "pl-terms", "terms_handle", "rec-terms", { body: "TERMS_BODY_SHOULD_NOT_LEAK" }),
      readyDraft("draft-op", "pl-op", "colonizehandle", "rec-op", { body: "OPERATOR_BODY_SHOULD_NOT_LEAK" }),
      readyDraft("draft-domain", "pl-domain", "domain_handle", "rec-domain", { body: "DOMAIN_BODY_SHOULD_NOT_LEAK" }),
      readyDraft("draft-cool", "pl-cool", "cool_handle", "rec-cool", { body: "COOLDOWN_BODY_SHOULD_NOT_LEAK" }),
      readyDraft("draft-bare", "pl-bare", "barehandle", "rec-bare", {
        track_id: "track-bare",
        body: BARE_BODY,
        song_dna_version_id: null,
      }),
    ],
    agh_handoff_records: [
      readyRecord("rec-a", "pl-a", "draft-a", "2026-10-22T15:00:00Z"),
      readyRecord("rec-b", "pl-b", "draft-b", "2026-10-22T15:01:00Z"),
      readyRecord("rec-c", "pl-c", "draft-c", "2026-10-22T15:02:00Z"),
      readyRecord("rec-terms", "pl-terms", "draft-terms", "2026-10-22T15:03:00Z"),
      readyRecord("rec-op", "pl-op", "draft-op", "2026-10-22T15:04:00Z"),
      readyRecord("rec-domain", "pl-domain", "draft-domain", "2026-10-22T15:05:00Z"),
      readyRecord("rec-cool", "pl-cool", "draft-cool", "2026-10-22T15:06:00Z"),
      readyRecord("rec-bare", "pl-bare", "draft-bare", "2026-10-22T15:07:00Z", {
        batch_id: "missing-batch",
        track_id: "track-bare",
        song_dna_version_id: null,
      }),
      { id: "rec-sent", batch_id: "b1", track_id: "track-med", playlist_target_id: "pl-a", queue_state: "SENT", submission_channel: "instagram_dm", submitted_at: "2026-10-14T15:00:00Z", packet: {} },
      { id: "rec-review", batch_id: "b1", track_id: "track-med", playlist_target_id: "pl-b", queue_state: "AWAITING_GROK_REVIEW", submission_channel: "instagram_dm", submitted_at: null, packet: {} },
      { id: "rec-email", batch_id: "b1", track_id: "track-med", playlist_target_id: "pl-a", queue_state: "APPROVED_FOR_SEND", submission_channel: "email", submitted_at: null, packet: {} },
    ],
  };
}

Deno.test("Muse, Grok and Fendi can read the send queue; the discovery credential cannot", async () => {
  await withEnv(ENV, () => {
    assert(igSendQueueReadable(museActor()));
    assert(igSendQueueReadable(grokActor()));
    assert(igSendQueueReadable({ kind: "fendi", userId: "u", label: "fendi" }));
    assert(!igSendQueueReadable(discoveryActor()));
  });
});

Deno.test("send queue releases a DM only when the shared pre-send gate passes", async () => {
  await withEnv(ENV, async () => {
    const res = await listIgDmSendQueue(stubSb(fixture(), {
      "pl-cool": { ok: false, code: "cooldown_conflict" },
    }), {}, museActor(), NOW);
    assertEquals(res.status, 200, JSON.stringify(res.data));
    assertEquals(res.data.send_owner, IG_SEND_OWNER);
    assertEquals(res.data.receipt_action, IG_RECEIPT_ACTION);
    const rows = res.data.rows as Row[];
    const ids = rows.map((r) => r.handoff_record_id);
    assertEquals(ids.includes("rec-sent"), false);
    assertEquals(ids.includes("rec-review"), false);
    assertEquals(ids.includes("rec-email"), false);

    const a = rows.find((r) => r.handoff_record_id === "rec-a")!;
    assertEquals(a.sendable, true);
    assertEquals(a.blockers, []);
    assertEquals(a.ig_handle, "@akhilsagar");
    assertEquals(a.ig_url, "https://instagram.com/akhilsagar");
    assertEquals(a.dm_body, POSITIVE_BODY);
    assertEquals(a.outreach_draft_id, "draft-a");
    assertEquals(a.generated_by, "claude_playlist_discovery");
    assertEquals(a.track_name, "Meditate");
    assertEquals(a.playlist_name, "Lyrical Rap");

    const b = rows.find((r) => r.handoff_record_id === "rec-b")!;
    assertEquals(b.sendable, false);
    assertEquals(b.blockers, ["draft_pending"]);
    assertEquals(b.dm_body, null);

    const c = rows.find((r) => r.handoff_record_id === "rec-c")!;
    assertEquals(c.sendable, false);
    assertEquals(c.blockers, ["route_evidence_stale"]);
    assertEquals(c.dm_body, null);

    const terms = rows.find((r) => r.handoff_record_id === "rec-terms")!;
    assertEquals(terms.sendable, true);
    assertEquals(terms.blockers, []);
    assertEquals(terms.warnings, ["terms_unconfirmed"]);
    assertEquals(terms.dm_body, "TERMS_BODY_SHOULD_NOT_LEAK");

    const op = rows.find((r) => r.handoff_record_id === "rec-op")!;
    assertEquals(op.blockers, ["blocked_operator"]);
    assertEquals(op.dm_body, null);

    const domain = rows.find((r) => r.handoff_record_id === "rec-domain")!;
    assertEquals(domain.blockers, ["blocked_domain"]);
    assertEquals(domain.dm_body, null);

    const cool = rows.find((r) => r.handoff_record_id === "rec-cool")!;
    assertEquals(cool.blockers, ["clearance_cooldown_conflict"]);
    assertEquals(cool.dm_body, null);

    const bare = rows.find((r) => r.handoff_record_id === "rec-bare")!;
    assertEquals(bare.sendable, false);
    assertEquals(bare.dm_body, null);
    for (const code of ["dna_missing", "batch_missing", "identity_unresolved", "route_verification_missing"]) {
      assert((bare.blockers as string[]).includes(code), `${code} missing from ${JSON.stringify(bare.blockers)}`);
    }
    assert(!(bare.blockers as string[]).includes("terms_unknown"));
    assert((bare.warnings as string[]).includes("terms_unconfirmed"));

    assertEquals(res.data.sendable_count, 2);
    const blob = JSON.stringify(res.data);
    assert(blob.includes(POSITIVE_BODY));
    assert(blob.includes("TERMS_BODY_SHOULD_NOT_LEAK"));
    for (const secret of [STALE_BODY, BARE_BODY, "OPERATOR_BODY_SHOULD_NOT_LEAK", "DOMAIN_BODY_SHOULD_NOT_LEAK", "COOLDOWN_BODY_SHOULD_NOT_LEAK"]) {
      assert(!blob.includes(secret), secret);
    }
  });
});

Deno.test("send queue refuses the discovery credential", async () => {
  await withEnv(ENV, async () => {
    const res = await listIgDmSendQueue(stubSb(fixture()), {}, discoveryActor());
    assertEquals(res.status, 403);
  });
});

const OPEN_DECISION: PreSendDecision = {
  sendable: true,
  blockers: [],
  warnings: [],
  dispatch: { body: "x", subject: null, recipient: "@held_handle" },
};

Deno.test("send queue row: a Fendi-authored draft is attribution-held, a missing handle blocks", () => {
  const held = sendQueueRow(
    { id: "r", playlist_target_id: "p", track_id: "t", outreach_draft_id: "d", packet: {} },
    { id: "d", status: "approved", body: "x", recipient: "@held_handle", generated_by: "fendi" },
    { playlist_name: "P", is_active: true },
    "T",
    OPEN_DECISION,
  );
  assertEquals(held.sendable, false);
  assertEquals(held.blockers, ["attribution_held"]);
  assertEquals(held.dm_body, null);

  const noHandle = sendQueueRow(
    { id: "r", playlist_target_id: "p", track_id: "t", outreach_draft_id: "d", packet: {} },
    { id: "d", status: "approved", body: "x", recipient: "https://instagram.com/x", generated_by: "claude_playlist_discovery" },
    { playlist_name: "P", is_active: true },
    "T",
    OPEN_DECISION,
  );
  assertEquals(noHandle.blockers, ["ig_handle_missing"]);
  assertEquals(noHandle.dm_body, null);
});

Deno.test("send queue row withholds the DM when the pre-send gate is closed or missing", () => {
  const secret = "SECRET_DM_BODY_do_not_leak";
  const closed: PreSendDecision = { sendable: false, blockers: ["terms_paid"], warnings: [], dispatch: null };
  const row = sendQueueRow(
    { id: "r", playlist_target_id: "p", track_id: "t", outreach_draft_id: "d", packet: {} },
    { id: "d", status: "approved", body: secret, recipient: "@handle", generated_by: "claude_playlist_discovery" },
    { playlist_name: "P", is_active: true },
    "T",
    closed,
  );
  assertEquals(row.sendable, false);
  assertEquals(row.dm_body, null);
  assertEquals(row.blockers, ["terms_paid"]);
  assert(!JSON.stringify(row).includes(secret));

  const missing = sendQueueRow(
    { id: "r", playlist_target_id: "p", track_id: "t", packet: {} },
    { id: "d", status: "approved", body: secret, recipient: "@handle", generated_by: "claude_playlist_discovery" },
    { playlist_name: "P", is_active: true },
    "T",
    null,
  );
  assertEquals(missing.sendable, false);
  assertEquals(missing.dm_body, null);
  assert((missing.blockers as string[]).includes("pre_send_gate_missing"));
  assert(!JSON.stringify(missing).includes(secret));
});

Deno.test("pickSendDraft prefers the linked draft, then the one pointing at the record, then the oldest approved", () => {
  const drafts: Row[] = [
    { id: "late", track_id: "t", playlist_id: "p", channel: "instagram_dm", status: "approved", generated_at: "2026-10-20T00:00:00Z", metadata: {} },
    { id: "early", track_id: "t", playlist_id: "p", channel: "instagram_dm", status: "approved", generated_at: "2026-10-10T00:00:00Z", metadata: {} },
    { id: "pointed", track_id: "t", playlist_id: "p", channel: "instagram_dm", status: "approved", generated_at: "2026-10-21T00:00:00Z", metadata: { handoff_record_id: "rec" } },
  ];
  assertEquals(pickSendDraft({ id: "rec", track_id: "t", playlist_target_id: "p", outreach_draft_id: "late" }, drafts)?.id, "late");
  assertEquals(pickSendDraft({ id: "rec", track_id: "t", playlist_target_id: "p", outreach_draft_id: null }, drafts)?.id, "pointed");
  assertEquals(pickSendDraft({ id: "other", track_id: "t", playlist_target_id: "p", outreach_draft_id: null }, drafts)?.id, "early");
  assertEquals(pickSendDraft({ id: "x", track_id: "t", playlist_target_id: "nope" }, drafts), null);
});

Deno.test("igHandleOf normalizes to @handle and rejects URLs", () => {
  assertEquals(igHandleOf("@Some.One"), "@Some.One");
  assertEquals(igHandleOf("", null, "plain_handle"), "@plain_handle");
  assertEquals(igHandleOf("https://instagram.com/x", "x/y"), null);
});

Deno.test("authorization: the Muse credential may read the send queue and record a receipt, nothing else", async () => {
  await withEnv(ENV, async () => {
    assertEquals([...MUSE_IG_ACTIONS].sort(), ["list_ig_dm_send_queue", "mark_manual_ig_dm_submitted"]);
    // deno-lint-ignore no-explicit-any
    const sb: any = { auth: { getUser: async () => ({ data: { user: null }, error: null }) } };
    const muse = req({ "x-muse-ig-receipt-secret": MUSE });
    const read = await authorizeAction("list_ig_dm_send_queue", muse, sb);
    assertEquals(read.ok, true, JSON.stringify(read));
    const receipt = await authorizeAction("mark_manual_ig_dm_submitted", muse, sb);
    assertEquals(receipt.ok, true, JSON.stringify(receipt));
    for (const denied of ["approve_handoff_records", "review_handoff_records", "list_web_form_handoffs", "list_handoff_batches"]) {
      const res = await authorizeAction(denied, muse, sb);
      assertEquals(res.ok, false, denied);
      assertEquals(res.status, 403, denied);
    }
  });
});
