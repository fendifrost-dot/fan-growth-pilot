import { isAllowedEventType, allowedEventTypesHint } from "../_shared/truth/truthContract.ts";
import { ingestTruthEvent } from "../_shared/truth/truthIngest.ts";
import { attributePurchase } from "../_shared/truth/attribution.ts";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-api-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ ok: false, error: "method_not_allowed" }, 405);
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }

  const et = body.event_type ?? body.type;
  const purchaseShortcut =
    body.orderId != null &&
    body.value != null &&
    body.currency != null &&
    body.source != null &&
    (et === undefined || et === null || et === "");

  try {
    if (purchaseShortcut) {
      await attributePurchase(
        String(body.orderId),
        parseFloat(String(body.value)),
        String(body.currency),
        String(body.source),
        {
          clickId: (body.clickId ?? body.click_id) as string | undefined,
          smartLinkId: body.smartLinkId as string | undefined,
          fbclid: body.fbclid as string | undefined,
          email: body.email as string | undefined,
          phone: body.phone as string | undefined,
        }
      );
      return json({ ok: true });
    }

    if (!et) {
      return json({ ok: false, error: "Event type is required (event_type or type)" }, 400);
    }
    if (!isAllowedEventType(String(et))) {
      return json(
        {
          ok: false,
          error: `Unsupported event_type. Allowed: ${allowedEventTypesHint()}.`,
        },
        400
      );
    }

    const result = await ingestTruthEvent(body);
    return json({
      ok: true,
      event_id: result.eventId,
      eventId: result.eventId,
      identity_id: result.identityId,
      identityId: result.identityId,
      lead_id: result.leadId ?? null,
      leadId: result.leadId ?? null,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[truth-ingest]", message);
    return json({ ok: false, error: message }, 400);
  }
});
