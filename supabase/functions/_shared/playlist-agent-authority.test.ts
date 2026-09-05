/**
 * Handler-level Claude/Grok/Fendi gates on approve_draft / send_campaign.
 * Uses a stub supabase so we never hit live outreach.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { runPlaylistAgentAction } from "./playlist-agent-run.ts";
import type { Actor } from "./outreach-auth.ts";
import type { OpsActor } from "./ops-actors.ts";

const admin: Actor = { kind: "user", userId: "admin-1", isAdmin: true };
const claude: OpsActor = { kind: "claude", userId: "admin-1", label: "claude" };
const grok: OpsActor = {
  kind: "grok_playlist_control",
  userId: "admin-1",
  label: "grok_playlist_control",
};
const fendi: OpsActor = { kind: "fendi", userId: "fendi-1", label: "fendi" };

// Minimal stub — approve/send gates fire before DB work when capability denied.
const sb = {
  from: () => {
    throw new Error("supabase should not be reached when capability denied");
  },
};

Deno.test("Claude cannot approve_draft", async () => {
  const r = await runPlaylistAgentAction(
    "approve_draft",
    { draft_id: "d1" },
    sb as never,
    "hub",
    admin,
    claude,
  );
  assertEquals(r.status, 403);
  assertEquals(String(r.data.error).includes("approve_playlist_drafts"), true);
});

Deno.test("Claude cannot send_campaign", async () => {
  const r = await runPlaylistAgentAction(
    "send_campaign",
    { campaign_id: "c1" },
    sb as never,
    "hub",
    admin,
    claude,
  );
  assertEquals(r.status, 403);
  assertEquals(String(r.data.error).includes("send_playlist_pitches"), true);
});

Deno.test("Claude cannot send_telegram_campaign", async () => {
  const r = await runPlaylistAgentAction(
    "send_telegram_campaign",
    {},
    sb as never,
    "hub",
    admin,
    claude,
  );
  assertEquals(r.status, 403);
});

Deno.test("Grok is permitted past capability gate for approve_draft (fails later on stub DB)", async () => {
  let reached = false;
  const grokSb = {
    from: () => {
      reached = true;
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: null, error: { message: "nf" } }),
          }),
        }),
      };
    },
  };
  const r = await runPlaylistAgentAction(
    "approve_draft",
    { draft_id: "d1" },
    grokSb as never,
    "hub",
    admin,
    grok,
  );
  assertEquals(reached, true);
  // Draft not found after passing capability gate
  assertEquals(r.status, 404);
});

Deno.test("Fendi is permitted past capability gate for send_campaign proxy", async () => {
  // send_campaign proxies to an edge function after the capability gate.
  // Assert we get past 403 even if the proxy throws without SUPABASE_URL.
  Deno.env.set("SUPABASE_URL", "https://example.supabase.co");
  try {
    const r = await runPlaylistAgentAction(
      "send_campaign",
      { campaign_id: "c1" },
      sb as never,
      "hub",
      admin,
      fendi,
    );
    assertEquals(r.status === 403, false);
  } catch (e) {
    // Network/proxy failure after gate is acceptable; capability denial is not.
    assertEquals(String(e).includes("not permitted"), false);
  }
});
