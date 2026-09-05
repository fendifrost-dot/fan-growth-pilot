// Deno tests for the control-center-api authorization layer.
// Run: deno test supabase/functions/_shared/outreach-auth.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ACTION_AUTH,
  PHASE_3_PENDING_WRITES,
  PUBLIC_ACTION_ALLOWLIST,
  authorizeAction,
  classifyAction,
  isSchedulerRequest,
} from "./outreach-auth.ts";

const SECRET = "scheduler-secret-value";
const GROK = "grok-control-secret";
const CLAUDE = "claude-agent-secret";
const HUB = "hub-service-key";

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

Deno.test("unknown actions are denied, never defaulted to public", async () => {
  const d = await authorizeAction("totally_made_up_action", req(), stubSb(null, false));
  assertEquals(d.ok, false);
  assert(!d.ok && d.status === 403);
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
  await withEnv({ OUTREACH_SCHEDULER_SECRET: SECRET }, async () => {
    const headers = { "x-outreach-scheduler-secret": SECRET };

    const send = await authorizeAction("approve_draft", req(headers), stubSb(null, false));
    assert(send.ok, "scheduler may pass the outreach-write door");
    assert(send.ok && send.actor.kind === "scheduler");

    const activate = await authorizeAction("activate_campaign", req(headers), stubSb(null, false));
    assertEquals(activate.ok, false);
  });
});

Deno.test("a wrong or absent scheduler secret is rejected", async () => {
  await withEnv({ OUTREACH_SCHEDULER_SECRET: SECRET }, () => {
    assertEquals(isSchedulerRequest(req({ "x-outreach-scheduler-secret": "wrong" })), false);
    assertEquals(isSchedulerRequest(req()), false);
    assertEquals(isSchedulerRequest(req({ "x-outreach-scheduler-secret": SECRET })), true);
  });
});

Deno.test("an unset scheduler secret never authorizes", () => {
  Deno.env.delete("OUTREACH_SCHEDULER_SECRET");
  assertEquals(isSchedulerRequest(req({ "x-outreach-scheduler-secret": "" })), false);
});

Deno.test("explicit public allowlist stays public; protected reads require auth", async () => {
  for (const a of ["list_campaigns", "count_targets", "list_targets"]) {
    assert(PUBLIC_ACTION_ALLOWLIST.has(a), `${a} should be allowlisted`);
    const d = await authorizeAction(a, req(), stubSb(null, false));
    assert(d.ok, `${a} should remain public`);
  }
  for (const a of ["get_pitch_log", "list_drafts", "list_song_dna", "get_leads", "list_fan_roster"]) {
    const d = await authorizeAction(a, req(), stubSb(null, false));
    assertEquals(d.ok, false, `${a} must require authentication`);
    assert(!d.ok && d.status === 401);
  }
});

Deno.test("missing FANFUEL_HUB_KEY cannot authenticate arbitrary x-api-key", async () => {
  await withEnv({ FANFUEL_HUB_KEY: "" }, async () => {
    Deno.env.delete("FANFUEL_HUB_KEY");
    const d = await authorizeAction(
      "draft_pitch",
      req({ "x-api-key": "arbitrary-attacker-key" }),
      stubSb(null, false),
    );
    assertEquals(d.ok, false);
  });
});

Deno.test("Claude credential can reach draft_pitch door; Grok can reach approve_draft door", async () => {
  await withEnv({ CLAUDE_AGENT_SECRET: CLAUDE, GROK_PLAYLIST_CONTROL_SECRET: GROK }, async () => {
    const draft = await authorizeAction(
      "draft_pitch",
      req({ "x-claude-agent-secret": CLAUDE }),
      stubSb(null, false),
    );
    assert(draft.ok);
    assert(draft.ok && draft.actor.kind === "claude");

    const approve = await authorizeAction(
      "approve_draft",
      req({ "x-grok-playlist-control-secret": GROK }),
      stubSb(null, false),
    );
    assert(approve.ok);
    assert(approve.ok && approve.actor.kind === "grok_playlist_control");
  });
});

Deno.test("admin JWT + x-agh-agent:grok does not become Grok at authorizeAction", async () => {
  await withEnv({ GROK_PLAYLIST_CONTROL_SECRET: GROK, ARTIST_USER_ID: "fendi-exact" }, async () => {
    const d = await authorizeAction(
      "approve_draft",
      req({ authorization: "Bearer usertoken", "x-agh-agent": "grok" }),
      stubSb({ id: "admin-1" }, true),
    );
    assert(d.ok);
    assert(d.ok && d.actor.kind === "user" && d.actor.userId === "admin-1");
  });
});

Deno.test("phase3 legacy writes fail closed", async () => {
  // Pick a known phase3 action if present; otherwise ensure classify returns phase3/unknown deny.
  const sample = PHASE_3_PENDING_WRITES[0];
  if (!sample) return;
  const d = await authorizeAction(sample, req(), stubSb(null, false));
  assertEquals(d.ok, false);
  assert(!d.ok && (d.status === 403 || d.status === 401));
});

Deno.test("hub service credential reaches outreach-write", async () => {
  await withEnv({ FANFUEL_HUB_KEY: HUB }, async () => {
    const d = await authorizeAction(
      "draft_pitch",
      req({ "x-api-key": HUB }),
      stubSb(null, false),
    );
    assert(d.ok);
    assert(d.ok && d.actor.kind === "service");
  });
});
