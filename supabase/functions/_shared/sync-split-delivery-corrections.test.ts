/**
 * Corrective coverage: hash integrity, evidence truth, delivery transport,
 * Claude download denial, and provider test-mode (no real Resend).
 */
import {
  assert,
  assertEquals,
  assertFalse,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { can, resolveOpsActor } from "./ops-actors.ts";
import {
  buildCanonicalDocument,
  deriveSplitsReadyFromSheet,
  DOCUMENT_KINDS,
  runSplitSheetAction,
} from "./split-sheets.ts";
import { runSplitSheetDeliveryAction } from "./split-sheet-delivery.ts";
import {
  isProviderTestMode,
  sanitizeProviderError,
  sendProviderEmail,
  utf8ToBase64,
} from "./provider-transport.ts";

function req(headers: Record<string, string> = {}): Request {
  return new Request("https://example.test/", { method: "POST", headers });
}

function withEnv(vars: Record<string, string>, fn: () => void | Promise<void>) {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = Deno.env.get(k);
    Deno.env.set(k, v);
  }
  const finish = () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v == null) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  };
  const result = fn();
  if (result && typeof (result as Promise<void>).then === "function") {
    return (result as Promise<void>).finally(finish);
  }
  finish();
}

const composition = [
  { legal_name: "Writer A", role: "writer", split_percent: 60 },
  { legal_name: "Writer B", role: "composer", split_percent: 40 },
];
const master = [{ legal_name: "Label LLC", ownership_percent: 100 }];

function canonicalOpts(extra: Record<string, unknown> = {}) {
  return {
    trackName: "Fixture Track",
    title: "Ownership summary",
    versionNumber: 1,
    documentKind: "agh_generated_summary",
    composition,
    master,
    generatedAt: "2026-09-13T00:00:00.000Z",
    oneStopMaster: true,
    publishingControlled: true,
    masterControlled: true,
    status: "final",
    ...extra,
  };
}

Deno.test("hash: identical canonical input produces the same hash", async () => {
  const a = await buildCanonicalDocument(canonicalOpts());
  const b = await buildCanonicalDocument(canonicalOpts());
  assertEquals(a.hash, b.hash);
  assertEquals(a.html, b.html);
  assert(!a.html.includes(a.hash), "stored artifact must not embed its own hash");
});

Deno.test("hash: any material alteration produces a different hash", async () => {
  const base = await buildCanonicalDocument(canonicalOpts());
  const pct = await buildCanonicalDocument(canonicalOpts({
    composition: [
      { legal_name: "Writer A", role: "writer", split_percent: 50 },
      { legal_name: "Writer B", role: "composer", split_percent: 50 },
    ],
  }));
  const owner = await buildCanonicalDocument(canonicalOpts({
    composition: [
      { legal_name: "Writer A Changed", role: "writer", split_percent: 60 },
      { legal_name: "Writer B", role: "composer", split_percent: 40 },
    ],
  }));
  const kind = await buildCanonicalDocument(canonicalOpts({ documentKind: "verified_signed" }));
  assert(base.hash !== pct.hash);
  assert(base.hash !== owner.hash);
  assert(base.hash !== kind.hash);
});

Deno.test("evidence states stay distinct; unverified cannot satisfy signed readiness", () => {
  assert(DOCUMENT_KINDS.includes("agh_generated_summary"));
  assert(DOCUMENT_KINDS.includes("contributor_confirmed"));
  assert(DOCUMENT_KINDS.includes("uploaded_signed"));
  assert(DOCUMENT_KINDS.includes("verified_signed"));
  const unsigned = deriveSplitsReadyFromSheet({
    status: "final",
    is_current: true,
    document_kind: "agh_generated_summary",
    document_hash: "abc",
    document_storage_path: "rights/a.html",
  });
  assertEquals(unsigned.splits_ready, true);
  const uploaded = deriveSplitsReadyFromSheet({
    status: "final",
    is_current: true,
    document_kind: "uploaded_signed",
    document_hash: "abc",
    document_storage_path: "rights/a.pdf",
  }, { verifiedEvidence: false });
  assertEquals(uploaded.splits_ready, false);
  const verified = deriveSplitsReadyFromSheet({
    status: "final",
    is_current: true,
    document_kind: "verified_signed",
    document_hash: "abc",
    document_storage_path: "rights/a.pdf",
  }, { verifiedEvidence: true });
  assertEquals(verified.splits_ready, true);
  const missingHash = deriveSplitsReadyFromSheet({
    status: "final",
    is_current: true,
    document_kind: "agh_generated_summary",
    document_hash: "",
    document_storage_path: "rights/a.html",
  });
  assertEquals(missingHash.splits_ready, false);
});

Deno.test("Claude cannot mint document download URLs", async () => {
  await withEnv({ CLAUDE_SYNC_DISCOVERY_SECRET: "sync-secret" }, async () => {
    const claude = resolveOpsActor(null, req({ "x-claude-sync-discovery-secret": "sync-secret" }));
    assertEquals(can(claude, "download_split_sheet_document"), false);
    const sb = {
      from() {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle: async () => ({ data: { id: "s1", document_storage_path: "x" }, error: null }),
        };
      },
    };
    const res = await runSplitSheetAction(
      "get_split_sheet_signed_url",
      { split_sheet_id: "s1" },
      sb as never,
      null,
      req({ "x-claude-sync-discovery-secret": "sync-secret" }),
    );
    assertEquals(res.status, 403);
    assertEquals(res.data.code, "claude_document_download_denied");
  });
});

function deliveryMock(store: {
  tracks: Record<string, unknown>[];
  sheets: Record<string, unknown>[];
  evidence?: Record<string, unknown>[];
  deliveries?: Record<string, unknown>[];
  audits?: Record<string, unknown>[];
  settings?: Record<string, unknown>;
}) {
  const state = {
    tracks: store.tracks,
    sheets: store.sheets,
    evidence: store.evidence ?? [],
    deliveries: store.deliveries ?? [],
    audits: store.audits ?? [],
    settings: store.settings ?? {
      split_sheet_delivery_policy: { default: "request_only", secure_link_ttl_seconds: 900 },
    },
  };
  function rows(name: string): Record<string, unknown>[] {
    if (name === "tracks") return state.tracks;
    if (name === "split_sheets") return state.sheets;
    if (name === "split_sheet_evidence") return state.evidence;
    if (name === "split_sheet_deliveries") return state.deliveries;
    if (name === "rights_document_audit_events") return state.audits;
    if (name === "ops_settings") {
      return Object.entries(state.settings).map(([k, v]) => ({ setting_key: k, setting_value: v }));
    }
    return [];
  }
  return {
    from(name: string) {
      const filters: { col: string; val: unknown }[] = [];
      const api: Record<string, unknown> = {
        select() { return api; },
        eq(col: string, val: unknown) { filters.push({ col, val }); return api; },
        limit() { return api; },
        order() { return api; },
        maybeSingle: async () => {
          const hit = rows(name).find((r) => filters.every((f) => r[f.col] === f.val)) ?? null;
          return { data: hit, error: null };
        },
        single: async () => {
          const hit = rows(name).find((r) => filters.every((f) => r[f.col] === f.val));
          return { data: hit ?? null, error: hit ? null : { message: "missing" } };
        },
        insert(row: Record<string, unknown>) {
          const inserted = { id: crypto.randomUUID(), ...row };
          if (name === "split_sheet_deliveries") state.deliveries.push(inserted);
          if (name === "rights_document_audit_events") state.audits.push(inserted);
          return {
            select: () => ({
              single: async () => ({ data: inserted, error: null }),
            }),
          };
        },
        update(patch: Record<string, unknown>) {
          return {
            eq(col: string, val: unknown) {
              const hit = rows(name).find((r) => r[col] === val);
              if (hit) Object.assign(hit, patch);
              return {
                select: () => ({
                  single: async () => ({ data: hit ?? null, error: hit ? null : { message: "missing" } }),
                }),
              };
            },
          };
        },
        then: (
          resolve: (v: { data: Record<string, unknown>[]; error: null }) => void,
        ) => {
          const matched = rows(name).filter((r) => filters.every((f) => r[f.col] === f.val));
          resolve({ data: matched, error: null });
        },
      };
      return api;
    },
    storage: {
      from() {
        return {
          createSignedUrl: async () => ({ data: { signedUrl: "https://example.test/signed?tok=1" }, error: null }),
        };
      },
    },
    _state: state,
  };
}

Deno.test("delivery: email sent only after mocked provider accept; web_form is not sent", async () => {
  await withEnv({
    GROK_PLAYLIST_CONTROL_SECRET: "grok-secret",
    ARTIST_USER_ID: "fendi-exact-id",
    AGH_PROVIDER_TEST_MODE: "1",
  }, async () => {
    const trackId = crypto.randomUUID();
    const sheetId = crypto.randomUUID();
    const sb = deliveryMock({
      tracks: [{
        id: trackId,
        name: "fixture",
        splits_ready: true,
        splits_ready_source: "authoritative_final",
        current_split_sheet_id: sheetId,
        split_sheet_delivery_policy: "request_only",
      }],
      sheets: [{
        id: sheetId,
        track_id: trackId,
        status: "final",
        is_current: true,
        document_kind: "agh_generated_summary",
        document_hash: (await buildCanonicalDocument(canonicalOpts())).hash,
        generated_html: (await buildCanonicalDocument(canonicalOpts())).html,
        document_storage_path: "rights/fixture.html",
        version_number: 1,
      }],
      audits: [{
        track_id: trackId,
        split_sheet_id: sheetId,
        event_kind: "delivery",
        actor_kind: "fendi",
        detail: { phase: "authorization_granted", granted_by_kind: "fendi" },
      }],
    });
    // Hash on sheet must match generated_html live hash.
    const live = await buildCanonicalDocument(canonicalOpts());
    (sb._state.sheets[0] as { document_hash: string; generated_html: string }).document_hash = live.hash;
    (sb._state.sheets[0] as { generated_html: string }).generated_html = live.html;

    const grok = resolveOpsActor(null, req({ "x-grok-playlist-control-secret": "grok-secret" }));
    const email = await runSplitSheetDeliveryAction(
      "deliver_split_sheet_to_sync_contact",
      {
        track_id: trackId,
        split_sheet_id: sheetId,
        delivery_reason: "recipient_requested",
        delivery_channel: "email",
        recipient_email: "supervisor@example.com",
      },
      sb as never,
      null,
      req({ "x-grok-playlist-control-secret": "grok-secret" }),
    );
    assertEquals(email.status, 200);
    assertEquals(email.data.sent, true);
    assertEquals(email.data.delivery_result, "sent");
    assert(String(email.data.provider_message_id || "").startsWith("test_"));

    const form = await runSplitSheetDeliveryAction(
      "deliver_split_sheet_to_sync_contact",
      {
        track_id: trackId,
        split_sheet_id: sheetId,
        delivery_reason: "recipient_requested",
        delivery_channel: "web_form",
        recipient_name: "Supervisor",
      },
      sb as never,
      null,
      req({ "x-grok-playlist-control-secret": "grok-secret" }),
    );
    assertEquals(form.status, 200);
    assertEquals(form.data.sent, false);
    assertEquals(form.data.delivery_result, "awaiting_manual_submission");
    assertEquals(typeof grok.kind, "string");
  });
});

Deno.test("delivery: provider failure stores failed and stays retryable", async () => {
  await withEnv({
    GROK_PLAYLIST_CONTROL_SECRET: "grok-secret",
    AGH_PROVIDER_TEST_MODE: "1",
    AGH_PROVIDER_FORCE_FAILURE: "simulated 502",
  }, async () => {
    const trackId = crypto.randomUUID();
    const sheetId = crypto.randomUUID();
    const live = await buildCanonicalDocument(canonicalOpts());
    const sb = deliveryMock({
      tracks: [{
        id: trackId,
        split_sheet_delivery_policy: "request_only",
        current_split_sheet_id: sheetId,
      }],
      sheets: [{
        id: sheetId,
        track_id: trackId,
        status: "final",
        is_current: true,
        document_kind: "agh_generated_summary",
        document_hash: live.hash,
        generated_html: live.html,
        document_storage_path: "rights/fixture.html",
        version_number: 1,
      }],
      audits: [{
        track_id: trackId,
        split_sheet_id: sheetId,
        event_kind: "delivery",
        actor_kind: "fendi",
        detail: { phase: "authorization_granted", granted_by_kind: "fendi" },
      }],
    });
    const failed = await runSplitSheetDeliveryAction(
      "deliver_split_sheet_to_sync_contact",
      {
        track_id: trackId,
        split_sheet_id: sheetId,
        delivery_reason: "recipient_requested",
        delivery_channel: "email",
        recipient_email: "supervisor@example.com",
      },
      sb as never,
      null,
      req({ "x-grok-playlist-control-secret": "grok-secret" }),
    );
    assertEquals(failed.status, 502);
    assertEquals(failed.data.sent, false);
    assertEquals(failed.data.delivery_result, "failed");
    assertEquals(failed.data.retryable, true);
  });
});

Deno.test("provider test mode never implies a live Resend call", async () => {
  await withEnv({ AGH_PROVIDER_TEST_MODE: "1" }, async () => {
    assertEquals(isProviderTestMode(), true);
    const ok = await sendProviderEmail({
      to: ["nobody@example.com"],
      subject: "t",
      text: "t",
      idempotencyKey: "unit-test-key",
    });
    assertEquals(ok.ok, true);
    if (ok.ok) assertEquals(ok.id, "test_unit-test-key");
    assertEquals(sanitizeProviderError("Bearer re_abc123 failure"), "Bearer [redacted] failure");
    assertEquals(utf8ToBase64("ok").length > 0, true);
  });
});

Deno.test("Fendi-only finalize/auth capabilities stay reserved", () => {
  withEnv({
    ARTIST_USER_ID: "fendi-exact-id",
    CLAUDE_SYNC_DISCOVERY_SECRET: "sync-secret",
    GROK_PLAYLIST_CONTROL_SECRET: "grok-secret",
  }, () => {
    const claude = resolveOpsActor(null, req({ "x-claude-sync-discovery-secret": "sync-secret" }));
    const grok = resolveOpsActor(null, req({ "x-grok-playlist-control-secret": "grok-secret" }));
    const fendi = resolveOpsActor({ kind: "user", userId: "fendi-exact-id", isAdmin: true }, null);
    assertFalse(can(claude, "finalize_split_sheet"));
    assertFalse(can(grok, "finalize_split_sheet"));
    assert(can(fendi, "finalize_split_sheet"));
    assertFalse(can(claude, "authorize_split_sheet_delivery"));
    assertFalse(can(grok, "authorize_split_sheet_delivery"));
    assert(can(fendi, "authorize_split_sheet_delivery"));
    assertFalse(can(claude, "verify_split_sheet_evidence"));
    assert(can(fendi, "verify_split_sheet_evidence"));
  });
});
