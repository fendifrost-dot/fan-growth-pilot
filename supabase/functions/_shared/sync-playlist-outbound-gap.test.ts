/**
 * Wiring contract for docs/SYNC_VS_PLAYLIST_OUTBOUND_GAP.md.
 * Source-read + actor matrix only. No network. No live Resend.
 */
import {
  assert,
  assertEquals,
  assertFalse,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { can, resolveOpsActor } from "./ops-actors.ts";
import { SYNC_DISCOVERY_TOOLS } from "./sync-discovery-mcp.ts";
import { SYNC_REGISTER_ACTIONS } from "./sync-registers.ts";
import { SYNC_CONTROL_ACTIONS } from "./sync-control.ts";
import { pitchFromEmail, pitchReplyTo } from "./resend-pitch.ts";

function req(headers: Record<string, string> = {}): Request {
  return new Request("https://example.test/", { method: "POST", headers });
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

function read(rel: string): string {
  return Deno.readTextFileSync(new URL(rel, import.meta.url));
}

Deno.test("playlist From/Reply-To defaults are @fendifrost.com, never Gmail", () => {
  withEnv({ FROM_EMAIL: "", REPLY_TO_EMAIL: "" }, () => {
    Deno.env.delete("FROM_EMAIL");
    Deno.env.delete("REPLY_TO_EMAIL");
    const from = pitchFromEmail();
    const reply = pitchReplyTo() ?? "";
    assertEquals(from, "pitches@fendifrost.com");
    assertEquals(reply, "replies@fendifrost.com");
    assertFalse(from.includes("gmail.com"), "playlist From must not default to Gmail");
    assertFalse(reply.includes("gmail.com"), "code default Reply-To is replies@, not Gmail");
  });
});

Deno.test("provider-transport shares the same From/Reply-To defaults as playlist", () => {
  const src = read("./provider-transport.ts");
  assert(src.includes('FROM_EMAIL") || "pitches@fendifrost.com"'), "sync transport must default From to pitches@");
  assert(src.includes('REPLY_TO_EMAIL") || "replies@fendifrost.com"'), "sync transport must default Reply-To to replies@");
  assert(src.includes("https://api.resend.com/emails"), "provider-transport must call Resend");
  assertFalse(/fendifrost@gmail\.com/.test(src), "provider-transport must not hard-code Gmail From");
});

Deno.test("playlist execute-pitch is a dedicated Resend edge writing pitch_log", () => {
  const exec = read("../execute-pitch/index.ts");
  const send = read("../send-pitch-email/index.ts");
  assert(exec.includes("https://api.resend.com/emails"), "execute-pitch must POST Resend");
  assert(exec.includes("pitchFromHeader"), "execute-pitch must use shared From helper");
  assert(exec.includes('from("pitch_log")'), "execute-pitch must write pitch_log");
  assert(exec.includes('dispatched_via: "execute-pitch"'), "execute-pitch must attribute the send");
  assert(exec.includes("FANFUEL_HUB_KEY"), "execute-pitch is hub-key gated");
  assert(send.includes('from("../_shared/resend-pitch.ts")') || send.includes("sendResendEmail"), "send-pitch-email uses shared helper");
  assert(send.includes('dispatched_via: "send-pitch-email"'), "send-pitch-email must attribute the send");
  const agent = read("./playlist-agent-run.ts");
  assert(agent.includes("/functions/v1/execute-pitch"), "approve_draft proxies execute-pitch");
});

Deno.test("sync submit uses CCA + sendProviderEmail; no execute-sync-pitch edge", () => {
  const control = read("./sync-control.ts");
  assert(control.includes("sendProviderEmail"), "submitSyncOutreach must wrap sendProviderEmail");
  assert(control.includes("submission_message_id"), "sync ledger is the draft row, not pitch_log");
  assertFalse(control.includes('from("licensing_pitch_log")'), "submit must not yet write licensing_pitch_log (documented gap)");
  assertFalse(control.includes('from("pitch_log")'), "sync must not write playlist pitch_log");
  assert(SYNC_CONTROL_ACTIONS.includes("submit_sync_outreach"));
  assert(SYNC_CONTROL_ACTIONS.includes("record_manual_sync_outreach_submission"));

  const cca = read("../control-center-api/index.ts");
  assert(cca.includes("isSyncControlAction"), "CCA must route sync control");
  assert(cca.includes("isSyncRegisterAction"), "CCA must route licensing register");

  const execSyncPath = new URL("../execute-sync-pitch", import.meta.url).pathname;
  let executeSyncPitchExists = true;
  try {
    Deno.statSync(execSyncPath);
  } catch {
    executeSyncPitchExists = false;
  }
  assertFalse(executeSyncPitchExists, "do not assume a dedicated execute-sync-pitch edge exists");
});

Deno.test("licensing register is record-only and never mentions Resend", () => {
  const src = read("./sync-registers.ts");
  assert(src.includes("No send path"), "sync-registers must keep the no-send contract comment");
  assertFalse(src.includes("api.resend.com"), "log_licensing_pitch must not call Resend");
  assertFalse(src.includes("sendProviderEmail"), "log_licensing_pitch must not use provider transport");
  assertFalse(src.includes("RESEND_API_KEY"), "licensing register must not read Resend secrets");
  assert(SYNC_REGISTER_ACTIONS.includes("log_licensing_pitch"));
  assert(SYNC_REGISTER_ACTIONS.includes("list_licensing_pitches"));
  assertEquals(SYNC_REGISTER_ACTIONS.includes("submit_sync_outreach" as typeof SYNC_REGISTER_ACTIONS[number]), false);
});

Deno.test("Claude sync MCP cannot approve or submit outreach", () => {
  assertFalse(
    (SYNC_DISCOVERY_TOOLS as readonly string[]).includes("submit_sync_outreach"),
  );
  assertFalse(
    (SYNC_DISCOVERY_TOOLS as readonly string[]).includes("approve_sync_outreach"),
  );
  assert((SYNC_DISCOVERY_TOOLS as readonly string[]).includes("create_sync_drafts"));
  assert((SYNC_DISCOVERY_TOOLS as readonly string[]).includes("advance_sync_batch"));
});

Deno.test("only Grok and Fendi may submit sync outreach; Claude and human_admin may not", () => {
  withEnv({
    GROK_PLAYLIST_CONTROL_SECRET: "grok-secret",
    CLAUDE_SYNC_DISCOVERY_SECRET: "sync-secret",
    ARTIST_USER_ID: "fendi-id",
  }, () => {
    const grok = resolveOpsActor(null, req({ "x-grok-playlist-control-secret": "grok-secret" }));
    const claude = resolveOpsActor(null, req({ "x-claude-sync-discovery-secret": "sync-secret" }));
    const fendi = resolveOpsActor({ kind: "user", userId: "fendi-id", isAdmin: true }, null);
    const admin = resolveOpsActor({ kind: "user", userId: "other-admin", isAdmin: true }, null);

    assertEquals(can(grok, "submit_sync_outreach"), true);
    assertEquals(can(fendi, "submit_sync_outreach"), true);
    assertEquals(can(claude, "submit_sync_outreach"), false);
    assertEquals(can(admin, "submit_sync_outreach"), false);
    assertEquals(can(claude, "draft_sync_pitch"), true);
    assertEquals(can(admin, "manage_sync_registers"), true);
  });
});

Deno.test("Admin licensing UI records pitches; it does not submit via Hub Resend", () => {
  const ui = Deno.readTextFileSync(new URL("../../../src/pages/admin/AdminLicensing.tsx", import.meta.url));
  assert(ui.includes("log_licensing_pitch"), "licensing UI records after the fact");
  assertFalse(ui.includes("submit_sync_outreach"), "licensing UI has no Hub submit button (documented gap)");
  assertFalse(ui.includes("sendProviderEmail"), "browser UI must never call the provider");
  assert(ui.includes("Record a licensing pitch"), "copy still describes a register, not a send");
});

Deno.test("resend-webhook only mutates playlist_targets, not sync ledgers", () => {
  const src = read("../resend-webhook/index.ts");
  assert(src.includes("playlist_targets"), "playlist bounce handling remains");
  assertFalse(src.includes("licensing_pitch_log"), "webhook does not yet touch licensing log (gap)");
  assertFalse(src.includes("sync_research_pitch_drafts"), "webhook does not yet touch sync drafts (gap)");
});

Deno.test("config.toml registers playlist send edges, not an execute-sync-pitch", () => {
  const cfg = Deno.readTextFileSync(new URL("../../../supabase/config.toml", import.meta.url));
  assert(cfg.includes("[functions.execute-pitch]"), "playlist dedicated edge is configured");
  assert(cfg.includes("[functions.send-pitch-email]"), "playlist alternate edge is configured");
  assertFalse(cfg.includes("[functions.execute-sync-pitch]"), "no dedicated sync send edge in config");
});
