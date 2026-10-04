import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { cooldownUntilIso, loggedPitchIdentity, runLogPitchSent } from "./log-pitch-sent.ts";

type Row = Record<string, unknown>;

Deno.test("loggedPitchIdentity copies track, Song DNA and cooldown from the draft or handoff", () => {
  const fields = loggedPitchIdentity({
    body: {},
    draft: {
      id: "draft-1",
      track_id: "track-1",
      song_dna_version_id: "dna-1",
      campaign_id: "camp-1",
      approved_by: "grok_playlist_control",
      approved_at: "2026-10-03T15:00:00.000Z",
      metadata: { follow_up_at: "2026-10-10T15:00:00.000Z" },
    },
    handoff: { track_id: "other", song_dna_version_id: "other-dna" },
    pitchedAt: "2026-10-04T15:00:00.000Z",
    cooldownDays: 90,
  });
  assertEquals(fields.track_id, "track-1");
  assertEquals(fields.song_dna_version_id, "dna-1");
  assertEquals(fields.draft_id, "draft-1");
  assertEquals(fields.follow_up_at, "2026-10-10T15:00:00.000Z");
  assertEquals(fields.cooldown_until, cooldownUntilIso("2026-10-04T15:00:00.000Z", 90));
  assertEquals(fields.approved_by, "grok_playlist_control");
});

function stubSb(tables: Record<string, Row[]>) {
  const inserted: Row[] = [];
  const updated: { table: string; row: Row }[] = [];
  // deno-lint-ignore no-explicit-any
  const sb: any = {
    from(table: string) {
      const filters: ((r: Row) => boolean)[] = [];
      let limitN = 1000;
      const rows = () => (tables[table] ?? []).filter((r) => filters.every((f) => f(r))).slice(0, limitN);
      // deno-lint-ignore no-explicit-any
      const chain: any = {
        select: () => chain,
        eq: (k: string, v: unknown) => (filters.push((r) => String(r[k]) === String(v)), chain),
        order: () => chain,
        limit: (n: number) => (limitN = n, chain),
        maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
        single: () => Promise.resolve({ data: rows()[0] ?? inserted[inserted.length - 1] ?? null, error: null }),
        insert: (row: Row) => {
          const withId = { id: "log-1", ...row };
          inserted.push(withId);
          tables[table] = [...(tables[table] ?? []), withId];
          return {
            select: () => ({ single: () => Promise.resolve({ data: withId, error: null }) }),
          };
        },
        update: (row: Row) => {
          updated.push({ table, row });
          return {
            eq: () => Promise.resolve({ data: null, error: null }),
          };
        },
      };
      return chain;
    },
  };
  return { sb, inserted, updated };
}

Deno.test("log_pitch_sent persists track_id, song DNA and cooldown from the handoff", async () => {
  const { sb, inserted } = stubSb({
    playlist_targets: [{ playlist_id: "pl-1", track_name: "", curator_email: "curator@example.test" }],
    outreach_drafts: [],
    agh_handoff_records: [{
      id: "rec-1",
      playlist_target_id: "pl-1",
      track_id: "track-9",
      song_dna_version_id: "dna-9",
      approved_by: "fendi",
      packet: { follow_up_at: "2026-11-01T00:00:00.000Z" },
      updated_at: "2026-10-04T00:00:00.000Z",
    }],
    artist_config: [{ key: "cooldown_days", value: 90 }],
    pitch_log: [],
  });
  const res = await runLogPitchSent({
    playlist_id: "pl-1",
    track_name: "Meditate",
    handoff_record_id: "rec-1",
    channel: "instagram_dm",
    sent_at: "2026-10-04T16:00:00.000Z",
  }, sb);
  assertEquals(res.status, 200, JSON.stringify(res.data));
  assertEquals(res.data.created, true);
  assertEquals(inserted.length, 1);
  assertEquals(inserted[0].track_id, "track-9");
  assertEquals(inserted[0].song_dna_version_id, "dna-9");
  assertEquals(inserted[0].follow_up_at, "2026-11-01T00:00:00.000Z");
  assertEquals(inserted[0].cooldown_until, cooldownUntilIso("2026-10-04T16:00:00.000Z", 90));
  assertEquals(inserted[0].approved_by, "fendi");
  assert(String(inserted[0].status) === "sent");
});
