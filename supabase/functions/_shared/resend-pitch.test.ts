import { assertEquals, assertFalse, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildResendPitchPayload,
  pitchFromEmail,
  pitchFromHeader,
  pitchReplyTo,
} from "./resend-pitch.ts";
import { isProviderTestMode, providerFromHeader, sendProviderEmail } from "./provider-transport.ts";

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

Deno.test("playlist From/Reply-To helpers stay on fendifrost.com and ignore SYNC_FROM_EMAIL", () => {
  withEnv({
    FROM_EMAIL: "",
    REPLY_TO_EMAIL: "",
    SYNC_FROM_EMAIL: "sync@fendifrost.com",
  }, () => {
    Deno.env.delete("FROM_EMAIL");
    Deno.env.delete("REPLY_TO_EMAIL");
    assertEquals(pitchFromEmail(), "pitches@fendifrost.com");
    assertEquals(pitchFromHeader(), "Fendi Frost <pitches@fendifrost.com>");
    assertEquals(pitchReplyTo(), "replies@fendifrost.com");
    const payload = buildResendPitchPayload({
      to: ["curator@example.com"],
      subject: "t",
      text: "hello",
    });
    assertEquals(payload.from, "Fendi Frost <pitches@fendifrost.com>");
    assertFalse(String(payload.from).includes("sync@"));
    assertFalse(String(payload.from).includes("gmail.com"));
  });
});

Deno.test("SYNC_FROM_EMAIL is env-only on the sync mailbox and never Gmail", () => {
  withEnv({
    FROM_EMAIL: "pitches@fendifrost.com",
    SYNC_FROM_EMAIL: "sync@fendifrost.com",
  }, () => {
    assertEquals(providerFromHeader(), "Fendi Frost <pitches@fendifrost.com>");
    assertEquals(providerFromHeader({ useSyncFrom: true }), "Fendi Frost <sync@fendifrost.com>");
  });
  withEnv({
    FROM_EMAIL: "pitches@fendifrost.com",
    SYNC_FROM_EMAIL: "fendifrost@gmail.com",
  }, () => {
    assertEquals(providerFromHeader({ useSyncFrom: true }), "Fendi Frost <pitches@fendifrost.com>");
    assertFalse(providerFromHeader({ useSyncFrom: true }).includes("gmail.com"));
  });
  withEnv({ FROM_EMAIL: "fendifrost@gmail.com", SYNC_FROM_EMAIL: "" }, () => {
    Deno.env.delete("SYNC_FROM_EMAIL");
    assertEquals(providerFromHeader(), "Fendi Frost <pitches@fendifrost.com>");
    assertStringIncludes(providerFromHeader(), "@fendifrost.com");
  });
});

Deno.test("provider forceTestMode never calls Resend", async () => {
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
      useSyncFrom: true,
    });
    assertEquals(sent.ok, true);
    if (sent.ok) {
      assertEquals(sent.id, "test_sync-dry");
      assertEquals(sent.raw.from, providerFromHeader({ useSyncFrom: true }));
    }
  });
});
