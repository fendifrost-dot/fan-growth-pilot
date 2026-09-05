/**
 * Claude / Grok / Fendi authority matrix + attribution anti-spoof checks.
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

function req(agent?: string): Request {
  const headers = new Headers();
  if (agent) headers.set("x-agh-agent", agent);
  return new Request("https://example.test", { headers });
}

Deno.test("Claude cannot approve DNA, send pitches, or approve sync/sample", () => {
  const actor = resolveOpsActor(user("admin-1"), req("claude"));
  assertEquals(actor.kind, "claude");
  assertEquals(can(actor, "approve_song_dna"), false);
  assertEquals(can(actor, "reject_song_dna"), false);
  assertEquals(can(actor, "send_playlist_pitches"), false);
  assertEquals(can(actor, "approve_playlist_drafts"), false);
  assertEquals(can(actor, "approve_sample_declaration"), false);
  assertEquals(can(actor, "approve_sync_eligibility"), false);
  assertEquals(can(actor, "alter_approved_song_dna"), false);
  assertEquals(can(actor, "draft_song_dna"), true);
  assertEquals(can(actor, "generate_playlist_drafts"), true);
  assertEquals(can(actor, "research_playlist_targets"), true);
});

Deno.test("Grok can approve/send drafts but cannot approve DNA or sync", () => {
  const actor = resolveOpsActor(user("admin-1"), req("grok_playlist_control"));
  assertEquals(actor.kind, "grok_playlist_control");
  assertEquals(can(actor, "approve_playlist_drafts"), true);
  assertEquals(can(actor, "send_playlist_pitches"), true);
  assertEquals(can(actor, "monitor_inbox"), true);
  assertEquals(can(actor, "open_incidents"), true);
  assertEquals(can(actor, "approve_song_dna"), false);
  assertEquals(can(actor, "approve_sample_declaration"), false);
  assertEquals(can(actor, "approve_sync_eligibility"), false);
  assertEquals(can(actor, "alter_approved_song_dna"), false);
});

Deno.test("Only exact ARTIST_USER_ID resolves as Fendi and may approve DNA/sample/sync", () => {
  const prev = Deno.env.get("ARTIST_USER_ID");
  Deno.env.set("ARTIST_USER_ID", "fendi-exact-id");
  try {
    const fendi = resolveOpsActor(user("fendi-exact-id"), null);
    assertEquals(fendi.kind, "fendi");
    assertEquals(can(fendi, "approve_song_dna"), true);
    assertEquals(can(fendi, "approve_sample_declaration"), true);
    assertEquals(can(fendi, "approve_sync_eligibility"), true);
    assertEquals(can(fendi, "alter_approved_song_dna"), true);

    const otherAdmin = resolveOpsActor(user("other-admin"), null);
    assertEquals(otherAdmin.kind, "human_admin");
    assertEquals(can(otherAdmin, "approve_song_dna"), false);
    assertEquals(can(otherAdmin, "approve_sample_declaration"), false);
    assertEquals(can(otherAdmin, "approve_sync_eligibility"), false);
  } finally {
    if (prev == null) Deno.env.delete("ARTIST_USER_ID");
    else Deno.env.set("ARTIST_USER_ID", prev);
  }
});

Deno.test("Agent header overrides admin user to Claude (cannot self-approve as Fendi)", () => {
  const prev = Deno.env.get("ARTIST_USER_ID");
  Deno.env.set("ARTIST_USER_ID", "fendi-exact-id");
  try {
    const spoof = resolveOpsActor(user("fendi-exact-id"), req("claude"));
    assertEquals(spoof.kind, "claude");
    assertEquals(can(spoof, "approve_song_dna"), false);
  } finally {
    if (prev == null) Deno.env.delete("ARTIST_USER_ID");
    else Deno.env.set("ARTIST_USER_ID", prev);
  }
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
  assertEquals(cleaned.discovered_by, undefined);
  assertEquals(cleaned.sent_by, undefined);
  assertEquals(cleaned.generated_by, undefined);
});

Deno.test("scheduler and human_admin are distinguishable OpsActor kinds", () => {
  const sched = resolveOpsActor({ kind: "scheduler" }, null);
  assertEquals(sched.kind, "scheduler");
  assertEquals(can(sched, "send_playlist_pitches"), false);
  assertEquals(can(sched, "monitor_inbox"), true);

  const admin = resolveOpsActor(user("admin-2"), null);
  assertEquals(admin.kind, "human_admin");
  assertEquals(can(admin, "send_playlist_pitches"), true);
  assertEquals(can(admin, "approve_song_dna"), false);
});
