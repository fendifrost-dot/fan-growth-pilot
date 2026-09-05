// Deno tests for shared send identity + hub-key gate.
// Run: deno test --allow-env supabase/functions/_shared/send-identity-gate.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isPitchIdentityGateArmed,
  requireHubKey,
  requirePitchIdentityGateArmed,
  requireSendIdentity,
} from "./send-identity-gate.ts";

Deno.test("requireHubKey rejects missing configured secret", () => {
  Deno.env.delete("FANFUEL_HUB_KEY");
  const r = requireHubKey(new Request("https://x/", { headers: { "x-api-key": "anything" } }));
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.error.includes("not configured"), true);
});

Deno.test("requireHubKey rejects missing credentials even when secret is set", () => {
  Deno.env.set("FANFUEL_HUB_KEY", "hub-secret");
  const r = requireHubKey(new Request("https://x/"));
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.error.includes("Missing credentials"), true);
  Deno.env.delete("FANFUEL_HUB_KEY");
});

Deno.test("requireHubKey rejects incorrect credentials", () => {
  Deno.env.set("FANFUEL_HUB_KEY", "hub-secret");
  const r = requireHubKey(new Request("https://x/", { headers: { "x-api-key": "wrong" } }));
  assertEquals(r.ok, false);
  Deno.env.delete("FANFUEL_HUB_KEY");
});

Deno.test("requireHubKey accepts matching x-api-key", () => {
  Deno.env.set("FANFUEL_HUB_KEY", "hub-secret");
  const r = requireHubKey(new Request("https://x/", { headers: { "x-api-key": "hub-secret" } }));
  assertEquals(r.ok, true);
  Deno.env.delete("FANFUEL_HUB_KEY");
});

Deno.test("pitch identity gate is unarmed unless PITCH_IDENTITY_GATE=required", () => {
  Deno.env.delete("PITCH_IDENTITY_GATE");
  assertEquals(isPitchIdentityGateArmed(), false);
  const u = requirePitchIdentityGateArmed();
  assertEquals(u.ok, false);
  if (!u.ok) assertEquals(u.status, 503);

  Deno.env.set("PITCH_IDENTITY_GATE", "required");
  assertEquals(isPitchIdentityGateArmed(), true);
  assertEquals(requirePitchIdentityGateArmed().ok, true);
  Deno.env.delete("PITCH_IDENTITY_GATE");
});

Deno.test("requireSendIdentity fails closed when gate unarmed (no title-only path)", async () => {
  Deno.env.delete("PITCH_IDENTITY_GATE");
  // deno-lint-ignore no-explicit-any
  const sb: any = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }) };
  const r = await requireSendIdentity(sb, {
    track_id: "5d09da7e-98cf-4276-8dca-861d1fbbfa98",
    campaign_id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
    track_name: "Designed For Me (Control)",
  });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.status, 503);
});

Deno.test("requireSendIdentity rejects missing track_id/campaign_id when armed", async () => {
  Deno.env.set("PITCH_IDENTITY_GATE", "required");
  // deno-lint-ignore no-explicit-any
  const sb: any = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }) };
  const r = await requireSendIdentity(sb, { track_name: "Control", playlist_id: "p1" });
  assertEquals(r.ok, false);
  if (!r.ok) {
    assertEquals(r.status, 400);
    assertEquals(r.error.includes("track_id"), true);
  }
  Deno.env.delete("PITCH_IDENTITY_GATE");
});
