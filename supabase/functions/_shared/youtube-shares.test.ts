/**
 * YouTube native share-seeding pilot — handler guardrails + auth wiring.
 * A share counts only when verified; measurement reports Observed Lift only.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isYouTubeShareAction, runYouTubeShareAction } from "./youtube-shares.ts";
import { ACTION_SPEC, requiredCapabilityForAction } from "./outreach-auth.ts";
import { can, resolveOpsActor, type OpsActor } from "./ops-actors.ts";

const FENDI: OpsActor = { kind: "fendi", userId: "fendi-1", label: "fendi" };

function req(headers: Record<string, string> = {}): Request {
  return new Request("https://example.test", { headers });
}
function withEnv(vars: Record<string, string>, fn: () => void) {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) { prev[k] = Deno.env.get(k); Deno.env.set(k, v); }
  try { fn(); } finally {
    for (const [k, v] of Object.entries(prev)) { if (v == null) Deno.env.delete(k); else Deno.env.set(k, v); }
  }
}

// Query stub whose .eq() chains and .order() resolves to fixed rows.
function stubSb(rows: Record<string, unknown>[]) {
  const builder: Record<string, unknown> = {};
  builder.select = () => builder;
  builder.eq = () => builder;
  builder.order = () => Promise.resolve({ data: rows, error: null });
  return { from: () => builder } as never;
}

Deno.test("every youtube-share action is capability-gated to manage_youtube_shares", () => {
  const actions = [
    "list_youtube_share_campaigns", "get_youtube_share_campaign", "list_youtube_share_targets",
    "list_youtube_share_moments", "list_youtube_share_outreach", "list_youtube_share_events",
    "get_youtube_share_measurement", "upsert_youtube_share_campaign", "upsert_youtube_share_target",
    "set_youtube_share_target_stage", "upsert_youtube_share_moment", "delete_youtube_share_moment",
    "upsert_youtube_share_outreach", "record_youtube_share_event", "verify_youtube_share_event",
    "reject_youtube_share_event", "record_youtube_share_metric",
  ];
  for (const a of actions) {
    assert(isYouTubeShareAction(a), `${a} must route to the youtube-share module`);
    assert(a in ACTION_SPEC, `${a} must be in ACTION_SPEC`);
    assertEquals(ACTION_SPEC[a].cls, "capability");
    assertEquals(requiredCapabilityForAction(a), "manage_youtube_shares");
  }
});

Deno.test("manage_youtube_shares is operator-only (Fendi/human admin), denied to machines", () => {
  withEnv({
    CLAUDE_AGENT_SECRET: "c", GROK_PLAYLIST_CONTROL_SECRET: "g",
    FANFUEL_HUB_KEY: "h", OUTREACH_SCHEDULER_SECRET: "s", ARTIST_USER_ID: "fendi-1",
  }, () => {
    const fendi = resolveOpsActor({ kind: "user", userId: "fendi-1", isAdmin: true }, null);
    const human = resolveOpsActor({ kind: "user", userId: "other", isAdmin: true }, null);
    const claude = resolveOpsActor(null, req({ "x-claude-agent-secret": "c" }));
    const grok = resolveOpsActor(null, req({ "x-grok-playlist-control-secret": "g" }));
    const service = resolveOpsActor(null, req({ "x-api-key": "h" }));
    const sched = resolveOpsActor(null, req({ "x-outreach-scheduler-secret": "s" }));
    assertEquals(can(fendi, "manage_youtube_shares"), true);
    assertEquals(can(human, "manage_youtube_shares"), true);
    assertEquals(can(claude, "manage_youtube_shares"), false);
    assertEquals(can(grok, "manage_youtube_shares"), false);
    assertEquals(can(service, "manage_youtube_shares"), false);
    assertEquals(can(sched, "manage_youtube_shares"), false);
  });
});

Deno.test("cannot activate a campaign without a video (validated before DB)", async () => {
  const res = await runYouTubeShareAction(
    "upsert_youtube_share_campaign",
    { campaign_type: "current_release", track_label: "Current", status: "active" },
    stubSb([]),
    FENDI,
  );
  assertEquals(res.status, 400);
  assert(String(res.data.error).includes("without a youtube_video_id"));
});

Deno.test("scores must be within 0-100", async () => {
  const res = await runYouTubeShareAction(
    "upsert_youtube_share_target",
    { campaign_id: "c1", channel_name: "X", audience_fit_score: 500 },
    stubSb([]),
    FENDI,
  );
  assertEquals(res.status, 400);
});

Deno.test("invalid funnel stage and metric window are rejected", async () => {
  const stage = await runYouTubeShareAction(
    "set_youtube_share_target_stage", { target_id: "t1", funnel_stage: "nope" }, stubSb([]), FENDI);
  assertEquals(stage.status, 400);
  const metric = await runYouTubeShareAction(
    "record_youtube_share_metric", { campaign_id: "c1", window_label: "plus_1y" }, stubSb([]), FENDI);
  assertEquals(metric.status, 400);
});

Deno.test("measurement reports Observed Lift = window - baseline (no attribution)", async () => {
  const rows = [
    { window_label: "baseline", captured_at: "2026-09-19T00:00:00Z", impressions: 100, views: 40, likes: 5, comments: 1 },
    { window_label: "plus_24h", captured_at: "2026-09-20T00:00:00Z", impressions: 180, views: 70, likes: 9, comments: 2 },
  ];
  const res = await runYouTubeShareAction("get_youtube_share_measurement", { campaign_id: "c1" }, stubSb(rows), FENDI);
  assertEquals(res.status, 200);
  const windows = res.data.windows as Array<Record<string, unknown>>;
  const plus24 = windows.find((w) => w.window_label === "plus_24h")!;
  const lift = plus24.observed_lift as Record<string, number>;
  assertEquals(lift.impressions, 80);
  assertEquals(lift.views, 30);
  assertEquals(String(res.data.disclaimer).toLowerCase().includes("observed lift"), true);
});

Deno.test("unknown action fails closed", async () => {
  const res = await runYouTubeShareAction("frobnicate_shares", {}, stubSb([]), FENDI);
  assertEquals(res.status, 400);
});
