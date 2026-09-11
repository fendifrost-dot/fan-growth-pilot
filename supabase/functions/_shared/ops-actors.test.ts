/**
 * Credential-backed Claude / Grok / Fendi authority matrix + anti-spoof checks.
 *
 * x-agh-agent / x-ops-agent headers must NEVER elevate identity.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import {
  can,
  resolveOpsActor,
  stripSpoofedAttribution,
} from "./ops-actors.ts";
import type { Actor } from "./outreach-auth.ts";

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

Deno.test("Claude credential can draft/research but cannot approve or send", () => {
  withEnv({ CLAUDE_AGENT_SECRET: "claude-secret" }, () => {
    const actor = resolveOpsActor(null, req({ "x-claude-agent-secret": "claude-secret" }));
    assertEquals(actor.kind, "claude");
    assertEquals(can(actor, "generate_playlist_drafts"), true);
    assertEquals(can(actor, "research_playlist_targets"), true);
    assertEquals(can(actor, "draft_song_dna"), true);
    assertEquals(can(actor, "verify_playlist_targets"), true);
    assertEquals(can(actor, "approve_playlist_drafts"), false);
    assertEquals(can(actor, "send_playlist_pitches"), false);
    assertEquals(can(actor, "monitor_inbox"), false);
    assertEquals(can(actor, "respond_to_curators"), false);
    assertEquals(can(actor, "approve_song_dna"), false);
  });
});

Deno.test("Grok credential can approve/send drafts but cannot approve DNA or sync", () => {
  withEnv({ GROK_PLAYLIST_CONTROL_SECRET: "grok-secret" }, () => {
    const actor = resolveOpsActor(null, req({ "x-grok-playlist-control-secret": "grok-secret" }));
    assertEquals(actor.kind, "grok_playlist_control");
    assertEquals(can(actor, "approve_playlist_drafts"), true);
    assertEquals(can(actor, "reject_playlist_drafts"), true);
    assertEquals(can(actor, "send_playlist_pitches"), true);
    assertEquals(can(actor, "monitor_inbox"), true);
    assertEquals(can(actor, "approve_song_dna"), false);
    assertEquals(can(actor, "draft_song_dna"), false);
    assertEquals(can(actor, "approve_sample_declaration"), false);
    assertEquals(can(actor, "approve_sync_eligibility"), false);
  });
});

Deno.test("Admin JWT + x-agh-agent:grok remains human_admin (no Grok impersonation)", () => {
  withEnv({ ARTIST_USER_ID: "fendi-exact-id", GROK_PLAYLIST_CONTROL_SECRET: "grok-secret" }, () => {
    const spoof = resolveOpsActor(user("admin-1"), req({ "x-agh-agent": "grok" }));
    assertEquals(spoof.kind, "human_admin");
    assertEquals(can(spoof, "approve_playlist_drafts"), false);
    assertEquals(can(spoof, "send_playlist_pitches"), false);
  });
});

Deno.test("Human admin cannot approve or send playlist pitches", () => {
  withEnv({ ARTIST_USER_ID: "fendi-exact-id" }, () => {
    const admin = resolveOpsActor(user("other-admin"), null);
    assertEquals(admin.kind, "human_admin");
    assertEquals(can(admin, "approve_playlist_drafts"), false);
    assertEquals(can(admin, "send_playlist_pitches"), false);
    assertEquals(can(admin, "generate_playlist_drafts"), true);
    assertEquals(can(admin, "research_playlist_targets"), true);
  });
});

Deno.test("Only exact ARTIST_USER_ID resolves as Fendi and may approve DNA/sample/sync", () => {
  withEnv({ ARTIST_USER_ID: "fendi-exact-id" }, () => {
    const fendi = resolveOpsActor(user("fendi-exact-id"), null);
    assertEquals(fendi.kind, "fendi");
    assertEquals(can(fendi, "approve_song_dna"), true);
    assertEquals(can(fendi, "approve_playlist_drafts"), true);
    assertEquals(can(fendi, "send_playlist_pitches"), true);
    assertEquals(can(fendi, "approve_sample_declaration"), true);
    assertEquals(can(fendi, "approve_sync_eligibility"), true);
  });
});

Deno.test("Agent header cannot remaps Fendi JWT into Claude privileges elevation for DNA", () => {
  withEnv({ ARTIST_USER_ID: "fendi-exact-id" }, () => {
    // Header is non-authoritative — Fendi credential (JWT) wins.
    const stillFendi = resolveOpsActor(user("fendi-exact-id"), req({ "x-agh-agent": "claude" }));
    assertEquals(stillFendi.kind, "fendi");
    assertEquals(can(stillFendi, "approve_song_dna"), true);
  });
});

Deno.test("Scheduler cannot approve or impersonate Grok via agent header", () => {
  withEnv({
    OUTREACH_SCHEDULER_SECRET: "sched-secret",
    GROK_PLAYLIST_CONTROL_SECRET: "grok-secret",
  }, () => {
    const sched = resolveOpsActor({ kind: "scheduler" }, req({ "x-agh-agent": "grok" }));
    assertEquals(sched.kind, "scheduler");
    assertEquals(can(sched, "approve_playlist_drafts"), false);
    assertEquals(can(sched, "send_playlist_pitches"), false);

    const viaSecret = resolveOpsActor(
      null,
      req({
        "x-outreach-scheduler-secret": "sched-secret",
        "x-agh-agent": "grok",
      }),
    );
    assertEquals(viaSecret.kind, "scheduler");
    assertEquals(can(viaSecret, "approve_playlist_drafts"), false);
  });
});

Deno.test("stripSpoofedAttribution removes caller-supplied identity fields", () => {
  const cleaned = stripSpoofedAttribution({
    track_id: "t1",
    approved_by: "not-fendi",
    discovered_by: "spoof",
    sent_by: "attacker",
    generated_by: "bot",
    notes: "keep-me",
  });
  assertEquals(cleaned.track_id, "t1");
  assertEquals(cleaned.notes, "keep-me");
  assertEquals(cleaned.approved_by, undefined);
  assertEquals(cleaned.generated_by, undefined);
  assertEquals(cleaned.sent_by, undefined);
});

Deno.test("Missing Grok secret never authenticates as Grok even with matching header", () => {
  withEnv({ GROK_PLAYLIST_CONTROL_SECRET: "" }, () => {
    Deno.env.delete("GROK_PLAYLIST_CONTROL_SECRET");
    const actor = resolveOpsActor(user("admin-1"), req({
      "x-agh-agent": "grok",
      "x-grok-playlist-control-secret": "anything",
    }));
    assertEquals(actor.kind, "human_admin");
  });
});


Deno.test("manage_* admin surfaces denied to Claude / Grok / service / scheduler", () => {
  withEnv({
    CLAUDE_AGENT_SECRET: "claude-secret",
    GROK_PLAYLIST_CONTROL_SECRET: "grok-secret",
    FANFUEL_HUB_KEY: "hub-key",
    OUTREACH_SCHEDULER_SECRET: "sched-secret",
    ARTIST_USER_ID: "fendi-exact-id",
  }, () => {
    const surfaces = [
      "manage_campaigns",
      "manage_catalog",
      "manage_smart_links",
      "manage_sync_registers",
      "manage_radio",
      "manage_fan_engagement",
    ] as const;

    const claude = resolveOpsActor(null, req({ "x-claude-agent-secret": "claude-secret" }));
    const grok = resolveOpsActor(null, req({ "x-grok-playlist-control-secret": "grok-secret" }));
    const service = resolveOpsActor(null, req({ "x-api-key": "hub-key" }));
    const sched = resolveOpsActor(null, req({ "x-outreach-scheduler-secret": "sched-secret" }));
    const human = resolveOpsActor(user("other-admin"), null);
    const fendi = resolveOpsActor(user("fendi-exact-id"), null);

    for (const cap of surfaces) {
      assertEquals(can(claude, cap), false, `claude must lack ${cap}`);
      assertEquals(can(grok, cap), false, `grok must lack ${cap}`);
      assertEquals(can(service, cap), false, `service must lack ${cap}`);
      assertEquals(can(sched, cap), false, `scheduler must lack ${cap}`);
      assertEquals(can(human, cap), true, `human_admin must have ${cap}`);
      assertEquals(can(fendi, cap), true, `fendi must have ${cap}`);
    }
  });
});

Deno.test("Claude retains research / verify / draft / evidence capabilities", () => {
  withEnv({ CLAUDE_AGENT_SECRET: "claude-secret" }, () => {
    const actor = resolveOpsActor(null, req({ "x-claude-agent-secret": "claude-secret" }));
    assertEquals(can(actor, "research_playlist_targets"), true);
    assertEquals(can(actor, "verify_playlist_targets"), true);
    assertEquals(can(actor, "generate_playlist_drafts"), true);
    assertEquals(can(actor, "run_placement_discovery"), true);
    assertEquals(can(actor, "record_research_evidence"), true);
    assertEquals(can(actor, "draft_song_dna"), true);
    assertEquals(can(actor, "research_sync_targets"), true);
    assertEquals(can(actor, "draft_sync_pitch"), true);
    assertEquals(can(actor, "approve_playlist_drafts"), false);
    assertEquals(can(actor, "send_playlist_pitches"), false);
    assertEquals(can(actor, "monitor_inbox"), false);
    assertEquals(can(actor, "review_handoff_batch"), false);
  });
});

Deno.test("claude_playlist_discovery is distinct from broad Claude and cannot mutate DNA", () => {
  withEnv({
    CLAUDE_PLAYLIST_DISCOVERY_SECRET: "pd-secret",
    CLAUDE_AGENT_SECRET: "claude-secret",
  }, () => {
    const pd = resolveOpsActor(null, req({ "x-claude-playlist-discovery-secret": "pd-secret" }));
    assertEquals(pd.kind, "claude_playlist_discovery");
    assertEquals(can(pd, "read_playlist_discovery_work"), true);
    assertEquals(can(pd, "submit_playlist_candidates"), true);
    assertEquals(can(pd, "generate_playlist_drafts"), true);
    assertEquals(can(pd, "draft_song_dna"), false);
    assertEquals(can(pd, "approve_playlist_drafts"), false);
    assertEquals(can(pd, "send_playlist_pitches"), false);
    assertEquals(can(pd, "manage_fan_engagement"), false);
    assertEquals(can(pd, "run_placement_discovery"), false);
    assertEquals(can(pd, "research_sync_targets"), false);

    // Hub key must not authenticate as playlist-discovery.
    Deno.env.set("FANFUEL_HUB_KEY", "hub-key");
    const hub = resolveOpsActor(null, req({ "x-api-key": "hub-key" }));
    assertEquals(hub.kind, "service");
  });
});

Deno.test("claude_sync_discovery is distinct and cannot touch playlist approve/send", () => {
  withEnv({
    CLAUDE_SYNC_DISCOVERY_SECRET: "sync-secret",
    CLAUDE_PLAYLIST_DISCOVERY_SECRET: "pd-secret",
    CLAUDE_AGENT_SECRET: "claude-secret",
  }, () => {
    const sd = resolveOpsActor(null, req({ "x-claude-sync-discovery-secret": "sync-secret" }));
    assertEquals(sd.kind, "claude_sync_discovery");
    assertEquals(can(sd, "research_sync_targets"), true);
    assertEquals(can(sd, "draft_sync_pitch"), true);
    assertEquals(can(sd, "read_playlist_discovery_work"), false);
    assertEquals(can(sd, "approve_sync_eligibility"), false);
    assertEquals(can(sd, "approve_playlist_drafts"), false);

    // Playlist secret must not elevate to sync discovery.
    const pd = resolveOpsActor(null, req({ "x-claude-playlist-discovery-secret": "pd-secret" }));
    assertEquals(pd.kind, "claude_playlist_discovery");
    assertEquals(can(pd, "research_sync_targets"), false);
  });
});

Deno.test("split-sheet capability matrix: Claude drafts, Grok delivers, Fendi finalizes", () => {
  withEnv({
    CLAUDE_AGENT_SECRET: "claude-secret",
    CLAUDE_SYNC_DISCOVERY_SECRET: "sync-secret",
    GROK_PLAYLIST_CONTROL_SECRET: "grok-secret",
    FANFUEL_HUB_KEY: "hub-key",
    ARTIST_USER_ID: "fendi-exact-id",
  }, () => {
    const claude = resolveOpsActor(null, req({ "x-claude-agent-secret": "claude-secret" }));
    const sync = resolveOpsActor(null, req({ "x-claude-sync-discovery-secret": "sync-secret" }));
    const grok = resolveOpsActor(null, req({ "x-grok-playlist-control-secret": "grok-secret" }));
    const service = resolveOpsActor(null, req({ "x-api-key": "hub-key" }));
    const human = resolveOpsActor(user("other-admin"), null);
    const fendi = resolveOpsActor(user("fendi-exact-id"), null);

    assertEquals(can(claude, "draft_split_sheet"), true);
    assertEquals(can(claude, "read_split_sheets"), true);
    assertEquals(can(claude, "finalize_split_sheet"), false);
    assertEquals(can(claude, "deliver_split_sheet"), false);

    assertEquals(can(sync, "draft_split_sheet"), true);
    assertEquals(can(sync, "finalize_split_sheet"), false);

    assertEquals(can(grok, "draft_split_sheet"), false);
    assertEquals(can(grok, "read_split_sheets"), true);
    assertEquals(can(grok, "deliver_split_sheet"), true);
    assertEquals(can(grok, "read_split_sheet_deliveries"), true);
    assertEquals(can(grok, "finalize_split_sheet"), false);
    assertEquals(can(grok, "authorize_split_sheet_delivery"), true);

    assertEquals(can(service, "draft_split_sheet"), true);
    assertEquals(can(service, "read_split_sheets"), true);
    assertEquals(can(service, "finalize_split_sheet"), false);
    assertEquals(can(service, "deliver_split_sheet"), false);

    assertEquals(can(human, "draft_split_sheet"), true);
    assertEquals(can(human, "manage_split_sheet_evidence"), true);
    assertEquals(can(human, "read_split_sheet_deliveries"), true);
    assertEquals(can(human, "finalize_split_sheet"), false);
    assertEquals(can(human, "authorize_split_sheet_delivery"), false);

    assertEquals(can(fendi, "finalize_split_sheet"), true);
    assertEquals(can(fendi, "authorize_split_sheet_delivery"), true);
    assertEquals(can(fendi, "deliver_split_sheet"), true);
  });
});
