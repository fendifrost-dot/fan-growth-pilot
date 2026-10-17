import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  authorizeResendWebhook,
  pitchLogBouncePatch,
  resendDeliveryFailure,
  resendProviderEmailId,
  resendRecipients,
  svixSignatureValid,
} from "./resend-webhook-event.ts";

const BOUNCED_EMAIL_ID = "01a14a67-2ecd-7e24-89be-2820768e6e46";
const RFC_MESSAGE_ID = "<010001a14a673003-01bbd0ff-8d86-4760-b4e3-789595b62295-000000@email.amazonses.com>";

const bouncedPayload = {
  email_id: BOUNCED_EMAIL_ID,
  message_id: RFC_MESSAGE_ID,
  to: ["ApolloSanthems@gmail.com"],
  bounce: { message: "mailbox unavailable", subType: "General", type: "Permanent" },
};

Deno.test("a bounce is matched by the Resend email id, not the RFC Message-ID", () => {
  assertEquals(resendDeliveryFailure("email.bounced"), "bounce");
  assertEquals(resendProviderEmailId(bouncedPayload), BOUNCED_EMAIL_ID);
  assert(resendProviderEmailId(bouncedPayload) !== RFC_MESSAGE_ID);
  assertEquals(resendProviderEmailId({ message_id: RFC_MESSAGE_ID }), "");
  assertEquals(resendRecipients(bouncedPayload), ["apollosanthems@gmail.com"]);
});

Deno.test("suppressed sends are bounces and delivered events are ignored", () => {
  assertEquals(resendDeliveryFailure("email.suppressed"), "bounce");
  assertEquals(resendDeliveryFailure("email.complained"), "complaint");
  assertEquals(resendDeliveryFailure("email.delivered"), null);
  assertEquals(resendDeliveryFailure("email.sent"), null);
  assertEquals(resendDeliveryFailure("suppression.added"), null);
  assertEquals(
    resendProviderEmailId({
      email_id: BOUNCED_EMAIL_ID,
      to: ["apollosanthems@gmail.com"],
      suppressed: { type: "OnAccountSuppressionList" },
    }),
    BOUNCED_EMAIL_ID,
  );
});

Deno.test("the pitch patch marks status and placement bounced and clears cooldown", () => {
  assertEquals(pitchLogBouncePatch(), {
    status: "bounced",
    placement_status: "bounced",
    cooldown_until: null,
  });
});

function bytesToB64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

async function signSvix(secret: string, id: string, timestamp: string, body: string): Promise<string> {
  const raw = Uint8Array.from(atob(secret.slice("whsec_".length)), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`));
  return `v1,${bytesToB64(new Uint8Array(mac))}`;
}

Deno.test("Svix-signed Resend deliveries pass and unsigned or stale ones do not", async () => {
  const key = crypto.getRandomValues(new Uint8Array(24));
  const secret = `whsec_${bytesToB64(key)}`;
  const rawBody = JSON.stringify({
    type: "email.bounced",
    data: bouncedPayload,
  });
  const now = 1_760_000_000;
  const id = "msg_bounce";
  const timestamp = String(now);
  const signature = await signSvix(secret, id, timestamp, rawBody);

  assert(await svixSignatureValid({
    secret,
    rawBody,
    id,
    timestamp,
    signature,
    nowSeconds: now,
  }));
  assertEquals(await authorizeResendWebhook({
    expectedSecret: secret,
    providedSecret: null,
    rawBody,
    svixId: id,
    svixTimestamp: timestamp,
    svixSignature: signature,
    nowSeconds: now,
  }), true);

  assertEquals(await authorizeResendWebhook({
    expectedSecret: secret,
    providedSecret: null,
    rawBody,
    svixId: null,
    svixTimestamp: null,
    svixSignature: null,
    nowSeconds: now,
  }), false);

  assertEquals(await svixSignatureValid({
    secret,
    rawBody: rawBody + " ",
    id,
    timestamp,
    signature,
    nowSeconds: now,
  }), false);

  assertEquals(await svixSignatureValid({
    secret,
    rawBody,
    id,
    timestamp: String(now - 301),
    signature: await signSvix(secret, id, String(now - 301), rawBody),
    nowSeconds: now,
  }), false);

  const shared = "shared-webhook-secret";
  assertEquals(await authorizeResendWebhook({
    expectedSecret: shared,
    providedSecret: shared,
    rawBody,
    svixId: id,
    svixTimestamp: timestamp,
    svixSignature: signature,
    nowSeconds: now,
  }), true);
  assertEquals(await authorizeResendWebhook({
    expectedSecret: shared,
    providedSecret: null,
    rawBody,
    svixId: id,
    svixTimestamp: timestamp,
    svixSignature: signature,
    nowSeconds: now,
  }), false);
  assertEquals(await authorizeResendWebhook({
    expectedSecret: "",
    providedSecret: null,
    rawBody,
    svixId: null,
    svixTimestamp: null,
    svixSignature: null,
  }), true);
});

Deno.test("resend webhook applies the bounce patch and still skips fendi and soundplate handoffs", () => {
  const src = Deno.readTextFileSync(new URL("../resend-webhook/index.ts", import.meta.url));
  const handoff = Deno.readTextFileSync(new URL("./handoff-sent.ts", import.meta.url));
  assert(src.includes("pitchLogBouncePatch"));
  assert(src.includes("authorizeResendWebhook"));
  assert(src.includes("markLinkedHandoffEmailBounced"));
  assert(src.includes("resendProviderEmailId"));
  assert(!src.includes('from("outreach_drafts")'));
  assert(handoff.includes('s(row.generated_by) === "fendi"'));
  assert(handoff.includes("emailRouteIsSoundplate"));
});
