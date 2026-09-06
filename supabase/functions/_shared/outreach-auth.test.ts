// Auto-aligned to outreach-auth.ts exports. Do not rename symbols by hand.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ACTION_AUTH,
  ACTION_SPEC,
  PHASE_3_PENDING_WRITES,
  PUBLIC_ACTION_ALLOWLIST,
  authorizeAction,
  classifyAction,
  isSchedulerRequest,
  requiredCapabilityForAction,
} from "./outreach-auth.ts";

const SECRET = "scheduler-secret-value";
const GROK = "grok-control-secret";
const CLAUDE = "claude-agent-secret";
const HUB = "hub-service-key";

function req(headers: Record<string, string> = {}): Request {
  return new Request("https://example.test/", { method: "POST", headers });
}

// deno-lint-ignore no-explicit-any
function stubSb(user: { id: string } | null, admin: boolean): any {
  return {
    auth: {
      getUser: (_t: string) =>
        Promise.resolve({
          data: { user },
          error: user ? null : new Error("bad token"),
        }),
    },
    from: () => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: () =>
          Promise.resolve({
            data: admin ? { role: "admin" } : null,
            error: null,
          }),
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

Deno.test("Phase 3 pending list is empty — discovery actions are capability-gated", () => {
  assertEquals(PHASE_3_PENDING_WRITES.length, 0);
  for (const a of [
    "run_playlist_research",
    "run_playlist_sweep",
    "reconcile_lane_targets",
    "discover_spotify_placements",
    "import_spotify_for_artists_csv",
    "enrich_curator_contacts",
    "verify_targets",
    "set_playlist_categories",
  ]) {
    assert(a in ACTION_SPEC, `${a} must be in ACTION_SPEC`);
    assertEquals(ACTION_SPEC[a].cls, "capability");
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

Deno.test("an admin reaches manage_campaigns and is attributed", async () => {
  const d = await authorizeAction(
    "activate_campaign",
    req({ authorization: "Bearer usertoken" }),
    stubSb({ id: "u1" }, true),
  );
  assert(d.ok, JSON.stringify(d));
  assert(d.ok && d.actor.kind === "user" && d.actor.userId === "u1");
  assert(d.ok && d.opsActor.kind === "human_admin");
  assertEquals(d.ok && d.capability, "manage_campaigns");
});

Deno.test("scheduler cannot approve or send; cannot activate campaigns", async () => {
  await withEnv({ OUTREACH_SCHEDULER_SECRET: SECRET }, async () => {
    const headers = { "x-outreach-scheduler-secret": SECRET };

    const approve = await authorizeAction("approve_draft", req(headers), stubSb(null, false));
    assertEquals(approve.ok, false, "scheduler must not approve drafts");

    const send = await authorizeAction("send_campaign", req(headers), stubSb(null, false));
    assertEquals(send.ok, false, "scheduler must not send campaigns");

    const activate = await authorizeAction("activate_campaign", req(headers), stubSb(null, false));
    assertEquals(activate.ok, false, "scheduler must not manage campaigns");
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

Deno.test("missing hub key cannot authenticate arbitrary x-api-key", async () => {
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

Deno.test("Claude can research / verify / categorize / draft; cannot approve or send", async () => {
  await withEnv({
    CLAUDE_AGENT_SECRET: CLAUDE,
    GROK_PLAYLIST_CONTROL_SECRET: GROK,
  }, async () => {
    const headers = { "x-claude-agent-secret": CLAUDE };
    for (const action of [
      "run_playlist_research",
      "run_playlist_sweep",
      "reconcile_lane_targets",
      "discover_spotify_placements",
      "import_spotify_for_artists_csv",
      "enrich_curator_contacts",
      "verify_targets",
      "set_playlist_categories",
      "draft_pitch",
    ]) {
      const d = await authorizeAction(action, req(headers), stubSb(null, false));
      assert(d.ok, `Claude should be allowed ${action}: ${JSON.stringify(d)}`);
      assert(d.ok && d.actor.kind === "claude");
      assert(d.ok && d.opsActor.kind === "claude");
    }

    for (const action of ["approve_draft", "send_campaign", "activate_campaign", "approve_song_dna"]) {
      const d = await authorizeAction(action, req(headers), stubSb(null, false));
      assertEquals(d.ok, false, `Claude must be denied ${action}`);
    }
  });
});

Deno.test("Grok can review/approve/send; cannot approve Song DNA / campaigns / spending surfaces", async () => {
  await withEnv({ GROK_PLAYLIST_CONTROL_SECRET: GROK }, async () => {
    const headers = { "x-grok-playlist-control-secret": GROK };
    for (const action of ["approve_draft", "send_campaign", "mark_pitch_response"]) {
      const d = await authorizeAction(action, req(headers), stubSb(null, false));
      assert(d.ok, `Grok should be allowed ${action}: ${JSON.stringify(d)}`);
      assert(d.ok && d.opsActor.kind === "grok_playlist_control");
    }
    for (const action of [
      "approve_song_dna",
      "activate_campaign",
      "upsert_smart_link",
      "log_licensing_pitch",
    ]) {
      const d = await authorizeAction(action, req(headers), stubSb(null, false));
      assertEquals(d.ok, false, `Grok must be denied ${action}`);
    }
  });
});

Deno.test("admin JWT + x-agh-agent:grok remains human_admin and cannot approve", async () => {
  await withEnv({
    GROK_PLAYLIST_CONTROL_SECRET: GROK,
    ARTIST_USER_ID: "fendi-exact",
  }, async () => {
    const d = await authorizeAction(
      "approve_draft",
      req({ authorization: "Bearer usertoken", "x-agh-agent": "grok" }),
      stubSb({ id: "admin-1" }, true),
    );
    assertEquals(d.ok, false, "human_admin must not approve playlist drafts");

    const campaign = await authorizeAction(
      "activate_campaign",
      req({ authorization: "Bearer usertoken", "x-agh-agent": "grok" }),
      stubSb({ id: "admin-1" }, true),
    );
    assert(campaign.ok, JSON.stringify(campaign));
    assert(campaign.ok && campaign.opsActor.kind === "human_admin");
    assert(campaign.ok && campaign.actor.kind === "user" && campaign.actor.userId === "admin-1");
  });
});

Deno.test("hub service credential can draft/research but not unrestricted admin writes", async () => {
  await withEnv({ FANFUEL_HUB_KEY: HUB }, async () => {
    const draft = await authorizeAction(
      "draft_pitch",
      req({ "x-api-key": HUB }),
      stubSb(null, false),
    );
    assert(draft.ok, JSON.stringify(draft));
    assert(draft.ok && draft.actor.kind === "service");

    const research = await authorizeAction(
      "run_playlist_research",
      req({ "x-api-key": HUB }),
      stubSb(null, false),
    );
    assert(research.ok, JSON.stringify(research));

    for (const action of [
      "activate_campaign",
      "approve_draft",
      "approve_song_dna",
      "upsert_smart_link",
    ]) {
      const d = await authorizeAction(action, req({ "x-api-key": HUB }), stubSb(null, false));
      assertEquals(d.ok, false, `service must be denied ${action}`);
    }
  });
});

Deno.test("Fendi exact user retains reserved Song DNA approval", async () => {
  await withEnv({ ARTIST_USER_ID: "fendi-exact" }, async () => {
    const d = await authorizeAction(
      "approve_song_dna",
      req({ authorization: "Bearer fendi-token" }),
      stubSb({ id: "fendi-exact" }, true),
    );
    assert(d.ok, JSON.stringify(d));
    assert(d.ok && d.opsActor.kind === "fendi");
    assertEquals(requiredCapabilityForAction("approve_song_dna"), "approve_song_dna");
  });
});

Deno.test("every ACTION_SPEC capability action has a required capability", () => {
  for (const [action, spec] of Object.entries(ACTION_SPEC)) {
    if (spec.cls === "capability") {
      assertEquals(requiredCapabilityForAction(action), spec.capability);
      assert(
        ACTION_AUTH[action] === "admin-write" || ACTION_AUTH[action] === "outreach-write",
        `${action} surface ${ACTION_AUTH[action]}`,
      );
    }
  }
});
