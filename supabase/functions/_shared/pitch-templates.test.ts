// Deno tests: template substitution + runDraftPitch identity / copy-source.
// Run: deno test supabase/functions/_shared/pitch-templates.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { applyPitchTemplate, varsFromPitchContext, type PitchContext } from "./pitch-templates.ts";
import { runDraftPitch } from "./playlist-agent-run.ts";

const COLD_SUBJECT = "Submission for {{playlist_name}}: {{artist_name}} — {{track_name}}";
const COLD_BODY = [
  "Hi {{curator_name}},",
  "",
  "I'd love to submit **{{track_name}}** for *{{playlist_name}}*.",
  "",
  "{{pitch}}",
  "",
  "{{stream_link}}",
  "Happy to share extra context or a different mix if useful.",
  "Thank you for your time.",
  "",
  "— {{artist_name}}",
].join("\n");

Deno.test("applyPitchTemplate substitutes every documented placeholder", () => {
  const rendered = applyPitchTemplate(COLD_SUBJECT, COLD_BODY, {
    curator_name: "Alex",
    playlist_name: "Night Drive",
    track_name: "Example Track",
    pitch: "KNOWN SHORT PITCH",
    stream_link: "Stream: https://open.spotify.com/track/x",
    artist_name: "Test Artist",
    prior_track: "Earlier Cut",
  });
  assertEquals(rendered.subject, "Submission for Night Drive: Test Artist — Example Track");
  assert(rendered.body.includes("KNOWN SHORT PITCH"));
  assert(rendered.body.includes("Hi Alex,"));
  assert(!rendered.body.includes("{{"));
});

Deno.test("varsFromPitchContext formats the stream link from platform + url", () => {
  const ctx: PitchContext = {
    curatorName: "Alex",
    playlistName: "Night Drive",
    trackName: "Example Track",
    shortPitch: "KNOWN SHORT PITCH",
    platform: "spotify",
    streamUrl: "https://open.spotify.com/track/x",
    isWarm: false,
    tone: "warm_personal",
    artistName: "Test Artist",
  };
  const vars = varsFromPitchContext(ctx);
  assertEquals(vars.stream_link, "Stream: https://open.spotify.com/track/x");
  assertEquals(vars.pitch, "KNOWN SHORT PITCH");
  assertEquals(vars.prior_track, "your last track");
});

// ---------------------------------------------------------------------------
// Minimal PostgREST stub. Rows are copied per from() so chained eq/ilike
// filters don't leak across queries.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function stubSb(tables: Record<string, Row[]>, inserted: Row[] = []): {
  // deno-lint-ignore no-explicit-any
  from: (table: string) => any;
  inserted: Row[];
} {
  const from = (table: string) => {
    let rows: Row[] = (tables[table] ?? []).map((r) => ({ ...r }));
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (col: string, val: unknown) => {
        rows = rows.filter((r) => r[col] === val || String(r[col]) === String(val));
        return chain;
      },
      ilike: (col: string, val: unknown) => {
        const want = String(val).replace(/\\/g, "").toLowerCase();
        rows = rows.filter((r) => String(r[col] ?? "").toLowerCase() === want);
        return chain;
      },
      or: () => chain,
      order: () => chain,
      limit: (n: number) => {
        rows = rows.slice(0, n);
        return chain;
      },
      maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
      single: () => Promise.resolve({ data: rows[0] ?? null, error: rows[0] ? null : { message: "no row" } }),
      insert: (row: Row) => {
        const withId = { id: `draft-${inserted.length + 1}`, ...row };
        inserted.push(withId);
        const insertChain = {
          select: () => ({
            single: () => Promise.resolve({ data: withId, error: null }),
          }),
        };
        return insertChain;
      },
      update: () => chain,
      upsert: () => chain,
      then: (
        resolve: (v: { data: Row[]; error: null }) => unknown,
      ) => Promise.resolve({ data: rows, error: null }).then(resolve),
    };
    return chain;
  };
  return { from, inserted };
}

const TRACK_A = {
  id: "track-a",
  name: "Example Track A",
  short_pitch: "KNOWN SHORT PITCH FROM TRACK A",
  pitch_angle: null,
  default_tone: "warm_personal",
  outreach_eligibility: "eligible",
  eligibility_reason: null,
  spotify_url: "https://open.spotify.com/track/aaa",
  apple_music_url: null,
  soundcloud_url: null,
  track_categories: [{ category_id: "cat-1", categories: { id: "cat-1", slug: "rap_general", label: "Rap" } }],
};

const PLAYLIST = {
  playlist_id: "spotify:pl1",
  playlist_name: "Night Drive",
  curator_name: "Alex",
  curator_email: "alex@example.com",
  lane: "rap_general",
  platform: "spotify",
  recommended_pitch_angle: null,
  verification_status: null,
  pitch_status: "not_pitched",
  fraud_verdict: "safe",
  submission_method: "email",
  playlist_categories: [],
  research_context: null,
};

const LANES_VALUE = {
  rap_general: { label: "Rap", pitch_angle: "LANE PITCH ANGLE MUST NOT APPEAR" },
  deep_house_groove: { label: "House", pitch_angle: "HOUSE LANE PITCH MUST NOT APPEAR" },
};

const TEMPLATE_ROW = {
  id: "tpl-1",
  tone: "warm_personal",
  channel: "email",
  is_warm: false,
  is_active: true,
  subject_template: COLD_SUBJECT,
  body_template: COLD_BODY,
};

function baseTables(track = TRACK_A, playlist = PLAYLIST): Record<string, Row[]> {
  return {
    playlist_targets: [playlist],
    tracks: [track],
    artist_config: [
      { key: "lanes", value: LANES_VALUE },
      { key: "artist_name", value: "Test Artist" },
    ],
    pitch_templates: [TEMPLATE_ROW],
    pitch_log: [],
    outreach_drafts: [],
  };
}

Deno.test("draft_pitch with track_id and with track_name produce identical subject and body", async () => {
  const tables = baseTables();
  const byId = stubSb(tables);
  const byName = stubSb(tables);
  const a = await runDraftPitch(
    { playlist_id: "spotify:pl1", track_id: "track-a", generated_by: "test" },
    byId as never,
  );
  const b = await runDraftPitch(
    { playlist_id: "spotify:pl1", track_name: "Example Track A", generated_by: "test" },
    byName as never,
  );
  assertEquals(a.status, 200, JSON.stringify(a.data));
  assertEquals(b.status, 200, JSON.stringify(b.data));
  const da = a.data as { subject: string; body: string };
  const db = b.data as { subject: string; body: string };
  assertEquals(da.subject, db.subject);
  assertEquals(da.body, db.body);
  assert(da.body.includes("KNOWN SHORT PITCH FROM TRACK A"));
});

Deno.test("track short_pitch wins over an unrelated lane pitch_angle", async () => {
  const tables = baseTables();
  const sb = stubSb(tables);
  const res = await runDraftPitch(
    { playlist_id: "spotify:pl1", track_id: "track-a" },
    sb as never,
  );
  assertEquals(res.status, 200, JSON.stringify(res.data));
  const body = (res.data as { body: string }).body;
  assert(body.includes("KNOWN SHORT PITCH FROM TRACK A"));
  assertEquals(body.includes("LANE PITCH ANGLE MUST NOT APPEAR"), false);
  assertEquals(body.includes("HOUSE LANE PITCH MUST NOT APPEAR"), false);
});

Deno.test("missing pitch copy on every source returns 422 and inserts no draft", async () => {
  const track = {
    ...TRACK_A,
    short_pitch: null,
    pitch_angle: null,
  };
  const playlist = { ...PLAYLIST, recommended_pitch_angle: null, lane: "rap_trap_hype" };
  const tables = baseTables(track, playlist);
  tables.artist_config = [
    { key: "lanes", value: { rap_trap_hype: { label: "Trap" } } },
    { key: "artist_name", value: "Test Artist" },
  ];
  const sb = stubSb(tables);
  const res = await runDraftPitch(
    { playlist_id: "spotify:pl1", track_id: "track-a" },
    sb as never,
  );
  assertEquals(res.status, 422);
  const data = res.data as { error: string };
  assertEquals(data.error, "No pitch copy configured");
  assertEquals(sb.inserted.length, 0);
});
