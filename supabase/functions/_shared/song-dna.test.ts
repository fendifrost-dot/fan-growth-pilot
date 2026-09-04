// Deno tests for Song DNA approval workflow.
// Run: deno test --allow-env supabase/functions/_shared/song-dna.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isSongDnaAction, runSongDnaAction } from "./song-dna.ts";
import type { Actor } from "./outreach-auth.ts";

// deno-lint-ignore no-explicit-any
function stubSb(state: { versions: any[]; audits?: any[] }): any {
  const versions = state.versions;
  const audits = state.audits ?? [];
  return {
    from: (table: string) => {
      if (table === "tracks") {
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: () => chain,
          update: () => ({
            eq: () => Promise.resolve({ data: null, error: null }),
          }),
          maybeSingle: () =>
            Promise.resolve({
              data: versions[0]
                ? { id: versions[0].track_id, name: "Fixture Track" }
                : { id: "t1", name: "Fixture Track" },
              error: null,
            }),
        };
        return chain;
      }
      if (table === "agh_config_audit_events") {
        return {
          insert: () => Promise.resolve({ error: null }),
        };
      }
      if (table === "song_dna_audit_events") {
        return {
          insert: (row: unknown) => {
            audits.push(row);
            return Promise.resolve({ error: null });
          },
          select: () => ({
            order: () => ({
              limit: () => ({
                eq: () => Promise.resolve({ data: audits, error: null }),
              }),
            }),
          }),
        };
      }
      let filterId: string | null = null;
      let filterTrack: string | null = null;
      let filterState: string | null = null;
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (col: string, val: string) => {
          if (col === "id") filterId = val;
          if (col === "track_id") filterTrack = val;
          if (col === "approval_state") filterState = val;
          return chain;
        },
        neq: () => chain,
        order: () => chain,
        limit: () => chain,
        insert: (row: unknown) => {
          const inserted = {
            ...(row as object),
            id: "dna-new",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
          versions.push(inserted);
          return {
            select: () => ({
              single: () => Promise.resolve({ data: inserted, error: null }),
            }),
          };
        },
        update: (patch: Record<string, unknown>) => ({
          eq: (col: string, val: string) => {
            const targets = versions.filter((v) => {
              if (col === "id") return v.id === val;
              if (col === "track_id") return v.track_id === val;
              return true;
            });
            for (const t of targets) Object.assign(t, patch);
            const afterEq = {
              eq: () => afterEq,
              neq: () => afterEq,
              select: () => ({
                single: () =>
                  Promise.resolve({
                    data: targets[0] ?? null,
                    error: targets[0] ? null : { message: "missing" },
                  }),
              }),
              then: (resolve: (v: unknown) => unknown) =>
                Promise.resolve({ data: null, error: null }).then(resolve),
            };
            return afterEq;
          },
        }),
        maybeSingle: () => {
          let rows = versions;
          if (filterId) rows = rows.filter((v) => v.id === filterId);
          if (filterTrack) rows = rows.filter((v) => v.track_id === filterTrack);
          if (filterState) rows = rows.filter((v) => v.approval_state === filterState);
          return Promise.resolve({ data: rows[0] ?? null, error: null });
        },
        single: () => Promise.resolve({ data: versions[0] ?? null, error: null }),
        then: (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
          Promise.resolve({ data: versions, error: null }).then(resolve),
      };
      return chain;
    },
  };
}

const admin: Actor = { kind: "user", userId: "fendi-admin", isAdmin: true };

Deno.test("isSongDnaAction claims DNA actions only", () => {
  assert(isSongDnaAction("approve_song_dna"));
  assertEquals(isSongDnaAction("create_campaign"), false);
});

Deno.test("create draft requires admin actor", async () => {
  const sb = stubSb({ versions: [] });
  const denied = await runSongDnaAction(
    "create_song_dna_draft",
    { track_id: "t1", primary_genre: "hip_hop_rap" },
    sb,
    null,
  );
  assertEquals(denied.status, 401);

  const ok = await runSongDnaAction(
    "create_song_dna_draft",
    {
      track_id: "t1",
      primary_genre: "hip_hop_rap",
      approved_lanes: ["rap_general"],
      short_pitch: "Song-specific pitch copy",
    },
    sb,
    admin,
  );
  assertEquals(ok.status, 200);
  assertEquals((ok.data.version as { approval_state: string }).approval_state, "draft");
});

Deno.test("approve requires pending state and records admin user id", async () => {
  const sb = stubSb({
    versions: [{
      id: "dna1",
      track_id: "t1",
      version_number: 1,
      approval_state: "pending_fendi_review",
      primary_genre: "hip_hop_rap",
      approved_lanes: ["rap_general"],
      short_pitch: "Approved pitch",
      sample_declaration: "no",
      sync_recommendation: "blocked",
    }],
  });
  const spoof = await runSongDnaAction(
    "approve_song_dna",
    { song_dna_version_id: "dna1", approved_by: "spoofed" },
    sb,
    null,
  );
  assertEquals(spoof.status, 401);

  const ok = await runSongDnaAction(
    "approve_song_dna",
    { song_dna_version_id: "dna1" },
    sb,
    admin,
  );
  assertEquals(ok.status, 200);
  assertEquals((ok.data.version as { approved_by: string }).approved_by, "fendi-admin");
  assertEquals((ok.data.version as { approval_state: string }).approval_state, "approved");
});

Deno.test("payload.requires_private_license blocks sync candidate without evidence", async () => {
  const sb = stubSb({ versions: [] });
  const r = await runSongDnaAction(
    "create_song_dna_draft",
    {
      track_id: "t-license",
      primary_genre: "hip_hop_rap",
      sync_recommendation: "candidate",
      payload: { requires_private_license: true },
    },
    sb,
    admin,
  );
  assertEquals(r.status, 400);
  assertEquals(String(r.data.error).includes("license"), true);
});

Deno.test("ordinary admin actor still required — anonymous cannot approve", async () => {
  const sb = stubSb({
    versions: [{
      id: "dna2",
      track_id: "t1",
      version_number: 1,
      approval_state: "pending_fendi_review",
      primary_genre: "house",
      approved_lanes: ["house_general"],
      short_pitch: "House pitch",
    }],
  });
  const ordinary: Actor = { kind: "user", userId: "not-admin", isAdmin: false };
  const denied = await runSongDnaAction(
    "approve_song_dna",
    { song_dna_version_id: "dna2" },
    sb,
    ordinary,
  );
  assertEquals(denied.status, 401);
});
