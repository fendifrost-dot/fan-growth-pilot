import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildResendPitchPayload,
  defaultSyncPitchSubject,
  pitchFromEmail,
  pitchFromHeader,
  pitchReplyTo,
} from "./resend-pitch.ts";
import { isProviderTestMode, sendProviderEmail } from "./provider-transport.ts";

function withEnv(vars: Record<string, string>, fn: () => void | Promise<void>) {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = Deno.env.get(k);
    Deno.env.set(k, v);
  }
  const finish = () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v == null) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  };
  const result = fn();
  if (result && typeof (result as Promise<void>).then === "function") {
    return (result as Promise<void>).finally(finish);
  }
  finish();
}

Deno.test("shared From wiring defaults to professional fendifrost.com mailbox", () => {
  withEnv({ FROM_EMAIL: "", REPLY_TO_EMAIL: "" }, () => {
    Deno.env.delete("FROM_EMAIL");
    Deno.env.delete("REPLY_TO_EMAIL");
    assertEquals(pitchFromEmail(), "pitches@fendifrost.com");
    assertEquals(pitchFromHeader(), "Fendi Frost <pitches@fendifrost.com>");
    assertEquals(pitchReplyTo(), "replies@fendifrost.com");
    const payload = buildResendPitchPayload({
      to: ["supervisor@example.com"],
      subject: "t",
      text: "hello",
    });
    assertEquals(payload.from, "Fendi Frost <pitches@fendifrost.com>");
    assertEquals(payload.reply_to, "replies@fendifrost.com");
  });
});

Deno.test("FROM_EMAIL env override stays on the shared helper (no parallel mail stack)", () => {
  withEnv({ FROM_EMAIL: "studio@fendifrost.com", REPLY_TO_EMAIL: "replies@fendifrost.com" }, () => {
    assertEquals(pitchFromHeader(), "Fendi Frost <studio@fendifrost.com>");
    assertStringIncludes(pitchFromHeader(), "@fendifrost.com");
  });
});

Deno.test("default sync subject uses caller track name, never a hardcoded title", () => {
  assertEquals(defaultSyncPitchSubject("Fixture Track", "Fixture Co"), "Fendi Frost — Fixture Track for Fixture Co");
  assertEquals(defaultSyncPitchSubject("Fixture Track"), "Fendi Frost — Fixture Track for licensing");
  assertEquals(defaultSyncPitchSubject(""), "Fendi Frost — licensing");
});

Deno.test("provider forceTestMode never calls Resend and reports shared From", async () => {
  await withEnv({
    AGH_PROVIDER_TEST_MODE: "",
    AGH_TEST_MODE: "",
    RESEND_API_KEY: "",
  }, async () => {
    Deno.env.delete("AGH_PROVIDER_TEST_MODE");
    Deno.env.delete("AGH_TEST_MODE");
    Deno.env.delete("RESEND_API_KEY");
    assertEquals(isProviderTestMode(), false);
    assertEquals(isProviderTestMode({ forceTestMode: true }), true);
    const sent = await sendProviderEmail({
      to: ["supervisor@example.com"],
      subject: "t",
      text: "t",
      idempotencyKey: "sync-dry",
      forceTestMode: true,
    });
    assertEquals(sent.ok, true);
    if (sent.ok) {
      assertEquals(sent.id, "test_sync-dry");
      assertEquals(sent.raw.from, pitchFromHeader());
    }
  });
});
