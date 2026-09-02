// Deno tests for Control same-target cooldown.
// Run: deno test supabase/functions/_shared/control-cooldown.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  CONTROL_TRACK_ID,
  evaluateControlSameTargetCooldown,
  isControlCooldownActive,
} from "./control-cooldown.ts";

Deno.test("blocks prior Control target during cooldown window", () => {
  const d = evaluateControlSameTargetCooldown({
    trackId: CONTROL_TRACK_ID,
    playlistId: "spotify:prior",
    priorPitchExists: true,
    now: new Date("2026-09-10T15:00:00Z"),
  });
  assertEquals(d.blocked, true);
  assertEquals(isControlCooldownActive(new Date("2026-09-10T15:00:00Z")), true);
});

Deno.test("allows new Control targets during the window", () => {
  const d = evaluateControlSameTargetCooldown({
    trackId: CONTROL_TRACK_ID,
    playlistId: "spotify:fresh",
    priorPitchExists: false,
    now: new Date("2026-09-10T15:00:00Z"),
  });
  assertEquals(d.blocked, false);
});

Deno.test("cooldown ends after 2026-09-14", () => {
  assertEquals(isControlCooldownActive(new Date("2026-09-16T00:00:00Z")), false);
  const d = evaluateControlSameTargetCooldown({
    trackId: CONTROL_TRACK_ID,
    playlistId: "spotify:prior",
    priorPitchExists: true,
    now: new Date("2026-09-16T00:00:00Z"),
  });
  assertEquals(d.blocked, false);
});
