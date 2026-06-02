import { applyTemplateSlots, type FanDmStage } from "./fan-dm-templates.ts";

export type PersonalizeResult = {
  message: string;
  method: "slots" | "openai";
};

export async function personalizeFanDm(
  templateBody: string,
  fan: { ig_handle: string; display_name?: string | null },
  stage: FanDmStage,
): Promise<PersonalizeResult> {
  const slotted = applyTemplateSlots(templateBody, fan);
  const apiKey = (Deno.env.get("OPENAI_API_KEY") || "").trim();
  if (!apiKey) {
    return { message: wrapFanSignoff(slotted), method: "slots" };
  }

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: Deno.env.get("OPENAI_FAN_DM_MODEL") || "gpt-4o-mini",
        temperature: 0.85,
        max_tokens: 220,
        messages: [
          {
            role: "system",
            content: [
              "You lightly personalize Instagram DMs for an artist (Fendi Frost).",
              "Rules: keep the SAME intent as the template; max 4 short sentences;",
              "no links unless template had one; no hard sell; no 'check out my' spam;",
              "sound human and warm; use their first name once;",
              "stage opener = no project pitch; runway = mention Runway Music naturally;",
              "invite = soft optional email list, easy to decline.",
              "Return ONLY the message body text, no quotes or labels.",
            ].join(" "),
          },
          {
            role: "user",
            content: [
              `Stage: ${stage}`,
              `Fan @${fan.ig_handle}`,
              `Display name: ${fan.display_name ?? "(unknown)"}`,
              `Template:\n${slotted}`,
            ].join("\n"),
          },
        ],
      }),
    });
    const data = await res.json().catch(() => ({})) as {
      choices?: { message?: { content?: string } }[];
      error?: { message?: string };
    };
    if (!res.ok) {
      console.warn("fan DM OpenAI fallback:", data.error?.message ?? res.status);
      return { message: wrapFanSignoff(slotted), method: "slots" };
    }
    const raw = data.choices?.[0]?.message?.content?.trim();
    if (!raw || raw.length < 12) {
      return { message: wrapFanSignoff(slotted), method: "slots" };
    }
    return { message: wrapFanSignoff(raw), method: "openai" };
  } catch (e) {
    console.warn("fan DM personalize error:", e);
    return { message: wrapFanSignoff(slotted), method: "slots" };
  }
}

function wrapFanSignoff(body: string): string {
  const trimmed = body.trim();
  if (/—\s*Fendi/i.test(trimmed) || /- Fendi/i.test(trimmed)) return trimmed;
  return `${trimmed}\n\n— Fendi`;
}
