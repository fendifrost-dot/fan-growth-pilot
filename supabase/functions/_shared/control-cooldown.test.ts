// Deno tests for Control same-target cooldown.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  CONTROL_TRACK_ID,
  evaluateControlSameTargetCooldown,
  isControlCooldownActive,
} from "./control-cooldown.ts";
import { TRACK_IDS } from "./catalog-rules.ts";

Deno.test("blocks prior Control target during cooldown window by UUID", () => {
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

Deno.test("non-Control UUID is never blocked by Control cooldown", () => {
  const d = evaluateControlSameTargetCooldown({
    trackId: TRACK_IDS.MEDITATE,
    playlistId: "spotify:prior",
    priorPitchExists: true,
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
