/**
 * Curator-level contact rules (2026-09-27): playlists sharing one curator are detected
 * and the existing per-song cooldown applies at the curator; other songs are reported only.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { curatorContactContext, normalizeFormKey } from "./curator-contact.ts";
import { markManualFormSubmitted } from "./handoff-queues.ts";
import { resolveOpsActor } from "./ops-actors.ts";

type Row = Record<string, unknown>;

function stubSb(tables: Record<string, Row[]>, fail: Record<string, string> = {}) {
  // deno-lint-ignore no-explicit-any
  const sb: any = {
    rpc: () => Promise.resolve({ data: null, error: { message: "no rpc" } }),
    from(table: string) {
      const filters: ((r: Row) => boolean)[] = [];
      const result = () =>
        fail[table]
          ? { data: null, error: { message: fail[table] } }
          : { data: (tables[table] ?? []).filter((r) => filters.every((f) => f(r))), error: null };
      // deno-lint-ignore no-explicit-any
      const chain: any = {
        select: () => chain,
        eq: (k: string, v: unknown) => (filters.push((r) => String(r[k]) === String(v)), chain),
        in: (k: string, v: unknown[]) => (filters.push((r) => v.map(String).includes(String(r[k]))), chain),
        not: (k: string) => (filters.push((r) => r[k] != null), chain),
        maybeSingle: () => Promise.resolve({ data: result().data?.[0] ?? null, error: result().error }),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(resolve(result())),
      };
      return chain;
    },
  };
  return sb;
}

const NOW = new Date("2026-09-27T20:00:00Z");
const DFM = "5d09da7e-98cf-4276-8dca-861d1fbbfa98";
const MED = "506ad12f-9e2e-450c-b2e9-f3d10670c015";

Deno.test("curator: form keys ignore scheme, www, trailing slash and query", () => {
  assertEquals(
    normalizeFormKey("https://www.DailyPlaylists.com/submit-song/add-song/?utm=x"),
    normalizeFormKey("http://dailyplaylists.com/submit-song/add-song"),
  );
});

Deno.test("curator: PlaylistDock cooldown identity keeps the slug", () => {
  assertEquals(
    normalizeFormKey("https://www.playlistdock.com/playlist.php?slug=Alpha&utm_source=x"),
    "playlistdock.com/playlist.php?slug=alpha",
  );
  assert(
    normalizeFormKey("https://playlistdock.com/playlist.php?slug=alpha") !==
      normalizeFormKey("https://curator.playlistdock.com/playlist.php?slug=beta"),
  );
});

Deno.test("curator: same song via a sibling playlist (shared email) is blocked; other song is reported only", async () => {
  const sb = stubSb({
    playlist_targets: [
      { playlist_id: "pl-a", curator_email: "curator@label.example" },
      { playlist_id: "pl-b", curator_email: "curator@label.example" },
    ],
    pitch_log: [
      { playlist_id: "pl-a", track_id: MED, track_name: "Meditate", status: "sent", curator_email: "curator@label.example", sent_at: "2026-09-20T15:00:00Z", cooldown_until: "2026-12-19T15:00:00Z" },
    ],
    agh_handoff_records: [],
    artist_config: [],
  });
  const dfm = await curatorContactContext(sb, {
    target: { playlist_id: "pl-b", curator_email: "Curator@Label.example" },
    trackId: DFM,
    trackName: "Designed For Me (Control)",
    now: NOW,
  });
  assertEquals(dfm.same_song_block, null);
  assertEquals(dfm.other_song_contacts.length, 1);
  assertEquals(dfm.sibling_playlist_ids.sort(), ["pl-a", "pl-b"]);

  const med = await curatorContactContext(sb, {
    target: { playlist_id: "pl-b", curator_email: "curator@label.example" },
    trackId: MED,
    trackName: "Meditate",
    now: NOW,
  });
  assert(med.same_song_block);
  assertEquals(med.same_song_block!.playlist_id, "pl-a");
  assertEquals(med.cooldown_days, 90);
});

Deno.test("curator: manual submission via a sibling sharing the same form blocks the same song", async () => {
  Deno.env.set("GROK_PLAYLIST_CONTROL_SECRET", "grok-secret");
  const grok = resolveOpsActor(null, new Request("https://x.test/", { method: "POST", headers: { "x-grok-playlist-control-secret": "grok-secret" } }));
  const form = "https://dailyplaylists.com/submit-song/add-song";
  const evidence = "DailyPlaylists free house list";
  const sb = stubSb({
    playlist_targets: [
      { playlist_id: "pl-club", verification_status: "auto_verified", path_verified: true, contact_method: "web_form", form_url: form, form_source_evidence: evidence },
      { playlist_id: "pl-dance", verification_status: "auto_verified", path_verified: true, contact_method: "web_form", form_url: form + "/", form_source_evidence: evidence },
    ],
    agh_handoff_records: [
      { id: "done", playlist_target_id: "pl-club", track_id: DFM, submitted_at: "2026-09-25T15:00:00Z", submission_channel: "web_form", queue_state: "APPROVED_FOR_SEND" },
      { id: "next", playlist_target_id: "pl-dance", track_id: DFM, submission_channel: "web_form", queue_state: "APPROVED_FOR_SEND", packet: {} },
    ],
    pitch_log: [],
    artist_config: [],
  });
  const res = await markManualFormSubmitted(sb, { handoff_record_id: "next" }, grok);
  assertEquals(res.status, 422, JSON.stringify(res.data));
  assertEquals(res.data.code, "curator_cooldown_same_song");
});

Deno.test("curator: a different PlaylistDock slug is not the same form", async () => {
  const sb = stubSb({
    playlist_targets: [
      { playlist_id: "pd-a", form_url: "https://playlistdock.com/playlist.php?slug=alpha" },
      { playlist_id: "pd-b", form_url: "https://www.playlistdock.com/playlist.php?slug=beta&utm=1" },
    ],
    pitch_log: [],
    agh_handoff_records: [
      { playlist_target_id: "pd-a", track_id: MED, submitted_at: "2026-09-25T15:00:00Z", submission_channel: "web_form" },
    ],
    artist_config: [],
  });
  const other = await curatorContactContext(sb, {
    target: { playlist_id: "pd-b", form_url: "https://playlistdock.com/playlist.php?slug=beta" },
    trackId: MED,
    trackName: "Other song",
    now: NOW,
  });
  assertEquals(other.same_song_block, null);
  assertEquals(other.sibling_playlist_ids, ["pd-b"]);

  const same = await curatorContactContext(sb, {
    target: { playlist_id: "pd-b", form_url: "https://playlistdock.com/playlist.php?slug=alpha" },
    trackId: MED,
    trackName: "Other song",
    now: NOW,
  });
  assert(same.same_song_block);
  assertEquals(same.same_song_block!.playlist_id, "pd-a");
});

Deno.test("curator: query errors fail closed", async () => {
  const sb = stubSb({ playlist_targets: [], artist_config: [] }, { pitch_log: "timeout" });
  const ctx = await curatorContactContext(sb, { target: { playlist_id: "p", curator_email: "a@b.example" }, trackId: DFM, trackName: null, now: NOW });
  assertEquals(ctx.error, "timeout");
});
