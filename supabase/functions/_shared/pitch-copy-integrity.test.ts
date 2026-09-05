/**
 * Pitch-copy integrity: hash + stale body detection.
 * Run: deno test supabase/functions/_shared/pitch-copy-integrity.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  hashPitchCopy,
  normalizePitchCopy,
  verifyDraftPitchIntegrity,
} from "./pitch-copy-integrity.ts";

Deno.test("hashPitchCopy is stable under whitespace normalization", async () => {
  const a = await hashPitchCopy("  deep house  groove  ");
  const b = await hashPitchCopy("deep house groove");
  assertEquals(a, b);
  assertEquals(normalizePitchCopy("  a   b  "), "a b");
});

Deno.test("hashPitchCopy differs when pitch text changes", async () => {
  const a = await hashPitchCopy("Meditate is a late-night rap record.");
  const b = await hashPitchCopy("Chicago deep-house influenced melodic rap");
  assertEquals(a === b, false);
});

Deno.test("legacy draft without hash refuses when body lacks current pitch", async () => {
  const currentPitch = "Meditate is a late-night rap record.";
  const currentHash = await hashPitchCopy(currentPitch);
  // deno-lint-ignore no-explicit-any
  const sb: any = {
    from: (table: string) => {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: () => {
          if (table === "tracks") {
            return Promise.resolve({
              data: { id: "t1", short_pitch: currentPitch, pitch_angle: null },
              error: null,
            });
          }
          if (table === "song_dna_versions") {
            return Promise.resolve({ data: null, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
      };
      return chain;
    },
  };

  const result = await verifyDraftPitchIntegrity(sb, {
    id: "draft-stale",
    track_id: "t1",
    body: "Hi — Chicago deep-house influenced melodic rap with a late-night luxury feel.",
    pitch_copy_hash: null,
  });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.code, "pitch_copy_stale_legacy");
    assertEquals(result.currentHash, currentHash);
  }
});

Deno.test("legacy draft without hash allows when body contains current pitch", async () => {
  const currentPitch = "Designed For Me sits in deep-house groove territory.";
  // deno-lint-ignore no-explicit-any
  const sb: any = {
    from: (table: string) => {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: () => {
          if (table === "tracks") {
            return Promise.resolve({
              data: { id: "t2", short_pitch: currentPitch, pitch_angle: null },
              error: null,
            });
          }
          return Promise.resolve({ data: null, error: null });
        },
      };
      return chain;
    },
  };

  const result = await verifyDraftPitchIntegrity(sb, {
    id: "draft-ok",
    track_id: "t2",
    body: `Hello curator\n\n${currentPitch}\n\nStream: https://x`,
    pitch_copy_hash: null,
  });
  assertEquals(result.ok, true);
});

Deno.test("hashed draft refuses when live pitch hash diverges", async () => {
  const oldHash = await hashPitchCopy("old pitch");
  // deno-lint-ignore no-explicit-any
  const sb: any = {
    from: (table: string) => {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: () => {
          if (table === "tracks") {
            return Promise.resolve({
              data: { id: "t3", short_pitch: "new pitch", pitch_angle: null },
              error: null,
            });
          }
          return Promise.resolve({ data: null, error: null });
        },
      };
      return chain;
    },
  };

  const result = await verifyDraftPitchIntegrity(sb, {
    id: "draft-hash",
    track_id: "t3",
    body: "old pitch was here",
    pitch_copy_hash: oldHash,
  });
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.code, "pitch_copy_changed");
});
