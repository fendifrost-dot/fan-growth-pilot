/**
 * Email handoff packet metadata + materialize path.
 * Packets must carry curator_email + outreach_draft_id (no pitch copy).
 * Materialize is Grok/Fendi recovery; scheduler cannot call it.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  mergeEmailHandoffPacketMeta,
  materializeEmailHandoffDrafts,
} from "./handoff-queues.ts";
import { resolveOpsActor } from "./ops-actors.ts";
import { ACTION_SPEC, requiredCapabilityForAction } from "./outreach-auth.ts";

function req(headers: Record<string, string> = {}): Request {
  return new Request("https://example.test", { headers });
}

function withEnv(vars: Record<string, string>, fn: () => void | Promise<void>) {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = Deno.env.get(k);
    Deno.env.set(k, v);
  }
  const done = () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v == null) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  };
  const out = fn();
  if (out && typeof (out as Promise<void>).then === "function") {
    return (out as Promise<void>).finally(done);
  }
  done();
}

Deno.test("email packet merge writes curator_email + outreach_draft_id", () => {
  const merged = mergeEmailHandoffPacketMeta(
    { packet_kind: "email_outreach_draft", track_id: "t1" },
    { curatorEmail: "A@Curator.Test", outreachDraftId: "draft-1", emailSendable: true },
  );
  assertEquals(merged.curator_email, "a@curator.test");
  assertEquals(merged.outreach_draft_id, "draft-1");
  assertEquals(merged.email_sendable, true);
  assertEquals(merged.channel, "email");
  assertEquals(merged.track_id, "t1");
});

Deno.test("ACTION_SPEC maps materialize to write_playlist_ops (Grok Playlist Control)", () => {
  assertEquals(ACTION_SPEC.materialize_email_handoff_drafts.cls, "capability");
  assertEquals(requiredCapabilityForAction("materialize_email_handoff_drafts"), "write_playlist_ops");
});

Deno.test("scheduler cannot materialize email handoff drafts", async () => {
  await withEnv({ OUTREACH_SCHEDULER_SECRET: "sched" }, async () => {
    const ops = resolveOpsActor(null, req({ "x-outreach-scheduler-secret": "sched" }));
    const res = await materializeEmailHandoffDrafts(
      { rpc: () => Promise.resolve({ data: { ok: true }, error: null }) } as never,
      { dry_run: true },
      ops,
    );
    assertEquals(res.status, 403);
    assertEquals(res.data.code, "authority_denied");
  });
});

Deno.test("Grok materialize defaults dry_run true and never claims a send", async () => {
  await withEnv({ GROK_PLAYLIST_CONTROL_SECRET: "grok-secret" }, async () => {
    const ops = resolveOpsActor(null, req({ "x-grok-playlist-control-secret": "grok-secret" }));
    let seenDry: unknown = undefined;
    const sb = {
      rpc: (_name: string, args: Record<string, unknown>) => {
        seenDry = args.p_dry_run;
        return Promise.resolve({
          data: {
            ok: true,
            scanned: 2,
            cloned_pending: 1,
            already_sent: 1,
            packet_enriched: 0,
            skipped: [],
          },
          error: null,
        });
      },
    };
    const res = await materializeEmailHandoffDrafts(sb as never, {}, ops);
    assertEquals(res.status, 200);
    assertEquals(seenDry, true);
    assertEquals(res.data.dry_run, true);
    assertEquals(res.data.sent, false);
    assertEquals(res.data.automated_submit, false);
    assertEquals(res.data.cloned_pending, 1);
  });
});

Deno.test("missing RPC is a 503, not a silent skip", async () => {
  await withEnv({ GROK_PLAYLIST_CONTROL_SECRET: "grok-secret" }, async () => {
    const ops = resolveOpsActor(null, req({ "x-grok-playlist-control-secret": "grok-secret" }));
    const sb = {
      rpc: () =>
        Promise.resolve({
          data: null,
          error: { message: "Could not find the function", code: "PGRST202" },
        }),
    };
    const res = await materializeEmailHandoffDrafts(sb as never, { dry_run: false }, ops);
    assertEquals(res.status, 503);
    assertEquals(res.data.code, "rpc_unavailable");
  });
});

Deno.test("materialize migration writes packet curator_email + outreach_draft_id and never hardcodes songs", () => {
  const sql = Deno.readTextFileSync(
    new URL("../../migrations/20260916120000_email_handoff_packet_materialize.sql", import.meta.url),
  );
  assert(sql.includes("agh_email_handoff_packet_merge"));
  assert(sql.includes("agh_materialize_email_handoff_drafts"));
  assert(sql.includes("'curator_email'"));
  assert(sql.includes("'outreach_draft_id'"));
  assert(sql.includes("cloned_pending_draft"));
  assert(sql.includes("already_sent"));
  assert(sql.includes("web_form"));
  assert(!/meditate|designed for me|designedforme/i.test(sql));
});
