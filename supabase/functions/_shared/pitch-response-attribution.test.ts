import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { pitchResponseActorLabel, runCatalogueAdmin } from "./playlist-agent-run.ts";

type Row = Record<string, unknown>;

function stub(rows: Row[], rpcImpl?: (name: string, args: Row) => { data: unknown; error: { message: string } | null }) {
  const calls: { name: string; args: Row }[] = [];
  const updates: Row[] = [];
  // deno-lint-ignore no-explicit-any
  const sb: any = {
    rpc: (name: string, args: Row) => {
      calls.push({ name, args });
      return Promise.resolve(rpcImpl ? rpcImpl(name, args) : { data: { ok: true, row: { id: args.p_id } }, error: null });
    },
    from: () => {
      const f: [string, unknown][] = [];
      let patch: Row | null = null;
      // deno-lint-ignore no-explicit-any
      const c: any = {
        select: () => c,
        eq: (k: string, v: unknown) => (f.push([k, v]), c),
        order: () => c,
        limit: () => Promise.resolve({ data: rows.filter((r) => f.every(([k, v]) => r[k] === v)), error: null }),
        update: (p: Row) => ((patch = p), updates.push(p), c),
        single: () => Promise.resolve({ data: { ...patch }, error: null }),
      };
      return c;
    },
  };
  return { sb, calls, updates };
}

const ROWS = [
  { id: "pl-med", playlist_id: "p1", track_name: "Meditate" },
  { id: "pl-dfm", playlist_id: "p1", track_name: "Designed For Me (Control)" },
];

Deno.test("mark_pitch_response: attributed RPC write names the real caller", async () => {
  const { sb, calls, updates } = stub(ROWS);
  const res = await runCatalogueAdmin(
    { action: "mark_pitch_response", pitch_log_id: "pl-med", placement_status: "replied", response_notes: "curator replied" },
    sb,
    { kind: "grok_playlist_control" },
  );
  assertEquals(res.status, 200);
  assertEquals(calls[0].name, "agh_update_pitch_response");
  assertEquals(calls[0].args.p_actor, "grok_playlist_control:mark_pitch_response");
  assertEquals(calls[0].args.p_patch, { placement_status: "replied", response_notes: "curator replied" });
  assertEquals(updates.length, 0); // no unattributed direct write
});

Deno.test("mark_pitch_response: playlist-only lookup refuses when rows span several songs", async () => {
  const { sb, calls } = stub(ROWS);
  const res = await runCatalogueAdmin({ action: "mark_pitch_response", playlist_id: "p1", placement_status: "placed" }, sb, { kind: "grok_playlist_control" });
  assertEquals(res.status, 409);
  assertEquals(res.data.code, "ambiguous_pitch_log_row");
  assertEquals(calls.length, 0);
  const ok = await runCatalogueAdmin(
    { action: "mark_pitch_response", playlist_id: "p1", track_name: "Meditate", placement_status: "replied" },
    sb,
    { kind: "grok_playlist_control" },
  );
  assertEquals(ok.status, 200);
  assertEquals(calls[0].args.p_id, "pl-med");
});

Deno.test("mark_pitch_response: falls back to a direct write only when the RPC is not installed", async () => {
  const { sb, updates } = stub(ROWS, () => ({ data: null, error: { message: "Could not find the function public.agh_update_pitch_response" } }));
  const res = await runCatalogueAdmin({ action: "mark_pitch_response", pitch_log_id: "pl-med", reply_received: true }, sb, { kind: "grok_playlist_control" });
  assertEquals(res.status, 200);
  assertEquals(res.data.attribution, "unavailable_migration_missing");
  assertEquals(updates.length, 1);
});

Deno.test("pitchResponseActorLabel: stable labels, no secrets", () => {
  assertEquals(pitchResponseActorLabel(null), "unknown");
  assertEquals(pitchResponseActorLabel({ kind: "user", userId: "u1", isAdmin: true }), "user:u1:admin");
  assertEquals(pitchResponseActorLabel({ kind: "claude" }), "claude");
});
