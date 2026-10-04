import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { plainManualSubmitError, webFormBlockers } from "./web-form-handoff.ts";

Deno.test("web form blockers explain an unapproved record and stay quiet for a batch-approved one", () => {
  const waiting = webFormBlockers({
    queue_state: "AWAITING_GROK_REVIEW",
    track_id: "t",
    playlist_target_id: "p",
    submission_channel: "web_form",
    packet: {},
  });
  assertEquals(waiting.some((b) => b.includes("waiting for review")), true);

  const warning = webFormBlockers({
    queue_state: "APPROVED_FOR_SEND",
    track_id: "t",
    playlist_target_id: "p",
    approved_by: "fendi",
    submission_channel: "web_form",
    packet: { grok_review: { verdict: "WARNING" } },
  });
  assertEquals(warning.some((b) => b.includes("WARNING")), true);

  const batchApproved = webFormBlockers({
    queue_state: "APPROVED_FOR_SEND",
    track_id: "t",
    playlist_target_id: "p",
    approved_by: "fendi",
    submission_channel: "web_form",
    packet: {},
  });
  assertEquals(batchApproved, []);
});

Deno.test("manual submit exceptions are plain language", () => {
  assertEquals(
    plainManualSubmitError("pass_approval_required")?.code,
    "pass_approval_required",
  );
  assertEquals(
    plainManualSubmitError("playlist_policy:curator_cooldown")?.error,
    "This curator is still in cooldown for this song.",
  );
  assertEquals(plainManualSubmitError("connection reset"), null);
});
