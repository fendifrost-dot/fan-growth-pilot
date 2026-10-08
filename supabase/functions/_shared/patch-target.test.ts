import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { runPlaylistAdmin } from "./playlist-agent-run.ts";

type Row = Record<string, unknown>;

/** Minimal PostgREST stub for patch_target: one existing target, lanes config empty. */
function stubSb(existing: Row | null) {
  const updates: Row[] = [];
  // deno-lint-ignore no-explicit-any
  const sb: any = {
    from(table: string) {
      // deno-lint-ignore no-explicit-any
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: () => {
          if (table === "playlist_targets") return Promise.resolve({ data: existing, error: null });
          return Promise.resolve({ data: null, error: null });
        },
        update: (row: Row) => {
          updates.push({ ...row });
          return { eq: () => Promise.resolve({ data: null, error: null }) };
        },
      };
      return chain;
    },
  };
  return { sb, updates };
}

const EXISTING = {
  playlist_id: "4rgyacoKVokP53SCN4DWUj",
  lane: null,
  research_context: null,
  similar_artists: null,
  curator_instagram: null,
  curator_email: null,
};

Deno.test("patch_target accepts submission_cost and does not write is_paid", async () => {
  for (const value of ["free", "paid", "unknown", "tip_appreciated"] as const) {
    const { sb, updates } = stubSb(EXISTING);
    const res = await runPlaylistAdmin({
      action: "patch_target",
      playlist_id: EXISTING.playlist_id,
      submission_cost: value,
      is_paid: value === "paid",
    }, sb);
    assertEquals(res.status, 200, JSON.stringify(res.data));
    assertEquals(updates.length, 1);
    assertEquals(updates[0].submission_cost, value);
    assertEquals("is_paid" in updates[0], false);
    assertEquals((res.data as { patched?: string[] }).patched, ["submission_cost"]);
  }

  const { sb, updates } = stubSb(EXISTING);
  const res = await runPlaylistAdmin({
    action: "patch_target",
    playlist_id: EXISTING.playlist_id,
    submission_cost: "Paid",
  }, sb);
  assertEquals(res.status, 200, JSON.stringify(res.data));
  assertEquals(updates[0].submission_cost, "paid");
});

Deno.test("patch_target rejects an invalid submission_cost with 400", async () => {
  const { sb, updates } = stubSb(EXISTING);
  const res = await runPlaylistAdmin({
    action: "patch_target",
    playlist_id: EXISTING.playlist_id,
    submission_cost: "premium",
  }, sb);
  assertEquals(res.status, 400);
  const data = res.data as { error?: string; field?: string; received?: unknown; allowed?: string[] };
  assertEquals(data.error, "invalid_field_value");
  assertEquals(data.field, "submission_cost");
  assertEquals(data.received, "premium");
  assertEquals(data.allowed, ["free", "paid", "tip_appreciated", "unknown"]);
  assertEquals(updates.length, 0);

  const empty = await runPlaylistAdmin({
    action: "patch_target",
    playlist_id: EXISTING.playlist_id,
    submission_cost: "  ",
  }, stubSb(EXISTING).sb);
  assertEquals(empty.status, 400);
  assertEquals((empty.data as { error?: string }).error, "invalid_field_value");
});

Deno.test("patch_target nothing-to-patch lists submission_cost and ignores is_paid", async () => {
  const { sb, updates } = stubSb(EXISTING);
  const res = await runPlaylistAdmin({
    action: "patch_target",
    playlist_id: EXISTING.playlist_id,
    is_paid: true,
  }, sb);
  assertEquals(res.status, 400);
  const message = String((res.data as { error?: string }).error ?? "");
  assert(message.includes("submission_cost"), message);
  assert(message.startsWith("Nothing to patch"), message);
  assertEquals(updates.length, 0);
});
