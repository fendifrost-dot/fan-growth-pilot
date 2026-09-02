import { describe, it, expect } from "vitest";
import {
  CONTROL_COOLDOWN_UNTIL_DATE,
  CONTROL_TRACK_ID,
  MONTH1_CANDIDATE_NOTICE,
  evaluateControlSameTargetCooldown,
  isControlCooldownActive,
  isControlTrackId,
} from "@/lib/controlCooldown";

describe("Control same-target cooldown", () => {
  it("uses the locked Control track UUID", () => {
    expect(isControlTrackId(CONTROL_TRACK_ID)).toBe(true);
    expect(isControlTrackId("506ad12f-9e2e-450c-b2e9-f3d10670c015")).toBe(false);
    expect(CONTROL_COOLDOWN_UNTIL_DATE).toBe("2026-09-14");
  });

  it("blocks same Control target while cooldown is active", () => {
    const during = new Date("2026-09-10T12:00:00Z");
    expect(isControlCooldownActive(during)).toBe(true);
    const d = evaluateControlSameTargetCooldown({
      trackId: CONTROL_TRACK_ID,
      playlistId: "spotify:abc",
      priorPitchExists: true,
      now: during,
    });
    expect(d.blocked).toBe(true);
    if (d.blocked) {
      expect(d.reason).toBe("control_same_target_cooldown");
      expect(d.message).toContain("2026-09-14");
    }
  });

  it("allows new Control targets (no prior pitch) during the window", () => {
    const d = evaluateControlSameTargetCooldown({
      trackId: CONTROL_TRACK_ID,
      playlistId: "spotify:new-target",
      priorPitchExists: false,
      now: new Date("2026-09-10T12:00:00Z"),
    });
    expect(d.blocked).toBe(false);
  });

  it("allows re-pitch of prior Control targets after 2026-09-14", () => {
    const d = evaluateControlSameTargetCooldown({
      trackId: CONTROL_TRACK_ID,
      playlistId: "spotify:abc",
      priorPitchExists: true,
      now: new Date("2026-09-16T12:00:00Z"),
    });
    expect(d.blocked).toBe(false);
  });

  it("does not apply the Control hold to Meditate", () => {
    const d = evaluateControlSameTargetCooldown({
      trackId: "506ad12f-9e2e-450c-b2e9-f3d10670c015",
      trackName: "Meditate",
      playlistId: "spotify:abc",
      priorPitchExists: true,
      now: new Date("2026-09-10T12:00:00Z"),
    });
    expect(d.blocked).toBe(false);
  });
});

describe("MEDITATE month-one candidate copy", () => {
  it("states that Meditate is not approved for sync submission", () => {
    expect(MONTH1_CANDIDATE_NOTICE).toContain("Month-one candidate");
    expect(MONTH1_CANDIDATE_NOTICE).toContain("not approved for sync submission");
    expect(MONTH1_CANDIDATE_NOTICE).toContain("Fendi completes DNA");
  });
});
