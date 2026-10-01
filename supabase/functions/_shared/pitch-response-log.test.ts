import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { logPitchResponse, safeEqual, validateLogInput } from "./pitch-response-log.ts";

type Row = Record<string, unknown>;

function stub(tables: Record<string, Row[]>, rpcRow?: Row) {
  const calls: Row[] = [];
  // deno-lint-ignore no-explicit-any
  const sb: any = {
    rpc: (name: string, args: Row) => {
      calls.push({ name, ...args });
      return Promise.resolve({ data: { ok: true, row: { ...(rpcRow ?? {}), placement_status: rpcRow?.placement_status ?? (args.p_patch as Row).placement_status } }, error: null });
    },
    from: (t: string) => {
      const f: ((r: Row) => boolean)[] = [];
      // deno-lint-ignore no-explicit-any
      const c: any = {
        select: () => c,
        eq: (k: string, v: unknown) => (f.push((r) => r[k] === v), c),
        ilike: (k: string, v: string) => (f.push((r) => String(r[k] ?? "").toLowerCase() === v.toLowerCase()), c),
        in: (k: string, v: unknown[]) => (f.push((r) => v.includes(r[k])), c),
        limit: () => Promise.resolve({ data: (tables[t] ?? []).filter((r) => f.every((p) => p(r))), error: null }),
        maybeSingle: () => Promise.resolve({ data: (tables[t] ?? []).find((r) => f.every((p) => p(r))) ?? null, error: null }),
      };
      return c;
    },
  };
  return { sb, calls };
}

const TABLES = () => ({
  pitch_log: [
    { id: "digi-med", playlist_id: "url:https://digiindie.com/submit", track_name: "Meditate", curator_email: "digiindie@gmail.com", status: "sent", placement_status: "accepted_free_promo" },
    { id: "digi-dfm", playlist_id: "url:https://digiindie.com/submit", track_name: "Designed For Me (Control)", curator_email: "digiindie@gmail.com", status: "sent", placement_status: "unknown" },
    { id: "old-row", playlist_id: "p-old", track_name: "Meditate", curator_email: null, status: "sent", placement_status: "unknown" },
    { id: "draft", playlist_id: "p-x", track_name: "Meditate", curator_email: "x@label.example", status: "pending", placement_status: "unknown" },
  ],
  playlist_targets: [{ playlist_id: "p-old", curator_email: "OLD@curator.example" }],
});

const BASE = { curator_email: "DigiIndie@gmail.com", track_name: "meditate", placement_status: "placed", response_notes: "Editorial selections: Meditate added", source: "gmail_digest", source_ref: "thread 1a0e" };

Deno.test("log: matches (curator, song) case-insensitively and writes an attributed response", async () => {
  const { sb, calls } = stub(TABLES(), { placement_status: "accepted_free_promo", placed: true });
  const res = await logPitchResponse(sb, BASE);
  assertEquals(res.status, 200);
  assertEquals(res.data.pitch_log_id, "digi-med");
  assertEquals(calls[0].name, "agh_update_pitch_response");
  assertEquals(calls[0].p_actor, "log-pitch-response:gmail_digest");
  const patch = calls[0].p_patch as Row;
  assertEquals(patch.placed, true);
  assertEquals(patch.reply_received, true);
  assertEquals(patch.response_notes, "[gmail_digest] Editorial selections: Meditate added (ref thread 1a0e)");
  // The preserve trigger kept the stronger existing outcome — reported, not hidden.
  assertEquals(res.data.placement_status, "accepted_free_promo");
  assertEquals(res.data.status_preserved, true);
});

Deno.test("log: falls back to the playlist curator email for older rows; ignores unsent drafts", async () => {
  const { sb } = stub(TABLES());
  const res = await logPitchResponse(sb, { ...BASE, curator_email: "old@curator.example", placement_status: "declined" });
  assertEquals(res.status, 200);
  assertEquals(res.data.pitch_log_id, "old-row");
  const none = await logPitchResponse(sb, { ...BASE, curator_email: "x@label.example" });
  assertEquals(none.status, 404);
  assertEquals(none.data.code, "no_matching_pitch");
});

Deno.test("log: never guesses between rows — ambiguous returns candidates and writes nothing", async () => {
  const t = TABLES();
  t.pitch_log.push({ id: "digi-med-2", playlist_id: "p-other", track_name: "Meditate", curator_email: "digiindie@gmail.com", status: "sent", placement_status: "unknown" });
  const { sb, calls } = stub(t);
  const res = await logPitchResponse(sb, BASE);
  assertEquals(res.status, 409);
  assertEquals(res.data.code, "ambiguous_pitch");
  assertEquals((res.data.candidates as Row[]).length, 2);
  assertEquals(calls.length, 0);
  const pinned = await logPitchResponse(sb, { ...BASE, pitch_log_id: "digi-med-2" });
  assertEquals(pinned.status, 200);
  assertEquals(calls[0].p_id, "digi-med-2");
});

Deno.test("log: dry_run shows the match and patch without writing", async () => {
  const { sb, calls } = stub(TABLES());
  const res = await logPitchResponse(sb, { ...BASE, dry_run: true });
  assertEquals(res.status, 200);
  assertEquals(res.data.dry_run, true);
  assertEquals((res.data.pitch_log as Row).id, "digi-med");
  assertEquals(calls.length, 0);
});

Deno.test("log: input validation", () => {
  assert(!validateLogInput({ placement_status: "placed", response_notes: "x" }).ok);
  assert(!validateLogInput({ ...BASE, placement_status: "sent" }).ok);
  assert(!validateLogInput({ ...BASE, response_notes: "" }).ok);
  assert(!validateLogInput({ ...BASE, curator_email: "not-an-email" }).ok);
  assert(!validateLogInput({ ...BASE, source: "bad label!" }).ok);
  const ok = validateLogInput({ ...BASE, placement_status: "no_response" });
  assert(ok.ok && ok.input.reply_received === false && ok.input.placed === false);
});

Deno.test("log: constant-time key compare", () => {
  assert(safeEqual("abcdefghijklmnopqrstuvwxyz", "abcdefghijklmnopqrstuvwxyz"));
  assert(!safeEqual("abcdefghijklmnopqrstuvwxyz", "abcdefghijklmnopqrstuvwxyZ"));
  assert(!safeEqual("short", "shorter"));
  assert(!safeEqual("", "x"));
});
