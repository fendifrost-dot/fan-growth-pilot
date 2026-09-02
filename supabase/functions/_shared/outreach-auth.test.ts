// Deno tests for the control-center-api authorization layer.
// Run: deno test supabase/functions/_shared/outreach-auth.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ACTION_AUTH,
  PHASE_3_PENDING_WRITES,
  authorizeAction,
  classifyAction,
  isSchedulerRequest,
} from "./outreach-auth.ts";

const SECRET = "scheduler-secret-value";

function req(headers: Record<string, string> = {}): Request {
  return new Request("https://example.test/", { method: "POST", headers });
}

// Stub client: `user` is the JWT-resolved user, `admin` whether a user_roles
// admin row exists.
// deno-lint-ignore no-explicit-any
function stubSb(user: { id: string } | null, admin: boolean): any {
  return {
    auth: {
      getUser: (_t: string) =>
        Promise.resolve({ data: { user }, error: user ? null : new Error("bad token") }),
    },
    from: () => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: () => Promise.resolve({ data: admin ? { role: "admin" } : null, error: null }),
      };
      return chain;
    },
  };
}

Deno.test("unknown actions are denied, never defaulted to public", async () => {
  const d = await authorizeAction("totally_made_up_action", req(), stubSb(null, false));
  assertEquals(d.ok, false);
  assert(!d.ok && d.status === 400);
});

Deno.test("every Phase 1 outreach-trigger action is a write class, not public", () => {
  const mustBeGated = [
    "approve_draft",
    "draft_pitch",
    "send_campaign",
    "send_radio_pitch",
    "queue_ig_outreach_batch",
    "upsert_smart_link",
    "patch_target",
    "activate_campaign",
    "end_campaign",
  ];
  for (const a of mustBeGated) {
    const cls = classifyAction(a);
    assert(
      cls === "admin-write" || cls === "outreach-write" || cls === "internal-scheduler",
      `${a} must be gated, got ${cls}`,
    );
  }
});

Deno.test("Phase 1 and Phase 3 action sets do not overlap", () => {
  for (const a of PHASE_3_PENDING_WRITES) {
    assertEquals(ACTION_AUTH[a], undefined, `${a} is in both Phase 1 and Phase 3`);
  }
});

Deno.test("anonymous cannot reach an outreach write", async () => {
  const d = await authorizeAction("approve_draft", req(), stubSb(null, false));
  assertEquals(d.ok, false);
  assert(!d.ok && d.status === 401);
});

Deno.test("a signed-in NON-admin cannot reach an outreach write", async () => {
  const d = await authorizeAction(
    "approve_draft",
    req({ authorization: "Bearer usertoken" }),
    stubSb({ id: "u1" }, false),
  );
  assertEquals(d.ok, false);
  assert(!d.ok && d.status === 403);
});

Deno.test("an admin reaches admin-write and is attributed", async () => {
  const d = await authorizeAction(
    "activate_campaign",
    req({ authorization: "Bearer usertoken" }),
    stubSb({ id: "u1" }, true),
  );
  assert(d.ok);
  assert(d.ok && d.actor.kind === "user" && d.actor.userId === "u1");
});

Deno.test("scheduler secret reaches outreach-write but NOT admin-write", async () => {
  Deno.env.set("OUTREACH_SCHEDULER_SECRET", SECRET);
  const headers = { "x-outreach-scheduler-secret": SECRET };

  const send = await authorizeAction("approve_draft", req(headers), stubSb(null, false));
  assert(send.ok, "scheduler must be able to drive the send path");
  assert(send.ok && send.actor.kind === "scheduler");

  // The scheduler must never be able to create or activate campaigns.
  const activate = await authorizeAction("activate_campaign", req(headers), stubSb(null, false));
  assertEquals(activate.ok, false);

  Deno.env.delete("OUTREACH_SCHEDULER_SECRET");
});

Deno.test("a wrong or absent scheduler secret is rejected", async () => {
  Deno.env.set("OUTREACH_SCHEDULER_SECRET", SECRET);
  assertEquals(isSchedulerRequest(req({ "x-outreach-scheduler-secret": "wrong" })), false);
  assertEquals(isSchedulerRequest(req()), false);
  assertEquals(isSchedulerRequest(req({ "x-outreach-scheduler-secret": SECRET })), true);
  Deno.env.delete("OUTREACH_SCHEDULER_SECRET");
});

Deno.test("an unset scheduler secret never authorizes", () => {
  Deno.env.delete("OUTREACH_SCHEDULER_SECRET");
  // Empty expected secret must not match an empty presented header.
  assertEquals(isSchedulerRequest(req({ "x-outreach-scheduler-secret": "" })), false);
});

Deno.test("campaign list requires sign-in; other Phase-1 reads stay public", async () => {
  const list = await authorizeAction("list_campaigns", req(), stubSb(null, false));
  assertEquals(list.ok, false);
  assert(!list.ok && list.status === 401);

  for (const a of ["get_pitch_log", "count_targets", "list_targets"]) {
    const d = await authorizeAction(a, req(), stubSb(null, false));
    assert(d.ok, `${a} should remain public`);
  }
});

Deno.test("catalogue writes require admin", () => {
  assertEquals(classifyAction("upsert_track"), "admin-write");
  assertEquals(classifyAction("set_track_categories"), "admin-write");
  assertEquals(classifyAction("upsert_category"), "admin-write");
});

Deno.test("anonymous cannot create or update campaigns", async () => {
  for (const a of ["create_campaign", "update_campaign", "list_campaignable_tracks"]) {
    const d = await authorizeAction(a, req(), stubSb(null, false));
    assertEquals(d.ok, false);
    assert(!d.ok && d.status === 401);
  }
});
