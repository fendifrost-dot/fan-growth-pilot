import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { cooldownConflictData, cooldownConflictFromPolicyError } from "./playlist-agent-run.ts";

const SPHERE = "365a53dc-ee9c-4652-9fb4-02aeced602a2";
const UNDERGROUND = "2db1125f-04a4-43df-82ed-e26a5a744750";

Deno.test("approve path returns cooldown_conflict and the prior pitch id", () => {
  assertEquals(
    cooldownConflictData({
      ok: false,
      code: "cooldown_conflict",
      pitch_log_id: SPHERE,
      cooldown_until: "2026-12-10T15:03:06.158Z",
    }),
    {
      ok: false,
      sent: false,
      code: "cooldown_conflict",
      pitch_log_id: SPHERE,
      cooldown_until: "2026-12-10T15:03:06.158Z",
      error: `playlist_policy:cooldown_conflict:${SPHERE}`,
    },
  );
  assertEquals(
    cooldownConflictFromPolicyError(`playlist_policy:cooldown_conflict:${UNDERGROUND}`),
    {
      ok: false,
      sent: false,
      code: "cooldown_conflict",
      pitch_log_id: UNDERGROUND,
      error: `playlist_policy:cooldown_conflict:${UNDERGROUND}`,
    },
  );
  assertEquals(cooldownConflictData({ ok: true, code: "eligible" }), null);
  assertEquals(cooldownConflictFromPolicyError("playlist_policy:paid_curator"), null);
});
