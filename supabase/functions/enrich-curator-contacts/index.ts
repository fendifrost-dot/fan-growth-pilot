import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-api-key",
};

const RATE_MS = 2000;

function getHubKey(req: Request): string {
  return (
    req.headers.get("x-api-key") ||
    req.headers.get("apikey") ||
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim()
  );
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

type Extracted = {
  curator_instagram?: string;
  curator_tiktok?: string;
  curator_twitter?: string;
  curator_website?: string;
  curator_linktree?: string;
  curator_email?: string;
};

function extractContacts(text: string): Extracted {
  const out: Extracted = {};
  const ig = text.match(/(?:https?:\/\/)?(?:www\.)?instagram\.com\/([a-zA-Z0-9._]+)/i);
  if (ig) out.curator_instagram = ig[1].replace(/\/$/, "");
  const tt = text.match(/(?:https?:\/\/)?(?:www\.)?tiktok\.com\/@([a-zA-Z0-9._]+)/i);
  if (tt) out.curator_tiktok = tt[1];
  const tw = text.match(/(?:https?:\/\/)?(?:www\.)?(?:twitter|x)\.com\/([a-zA-Z0-9_]+)/i);
  if (tw) out.curator_twitter = tw[1];
  const lt = text.match(/(?:https?:\/\/)?(?:linktr\.ee|beacons\.ai)\/([a-zA-Z0-9._-]+)/i);
  if (lt) out.curator_linktree = lt[0];
  const handle = text.match(/@([a-zA-Z0-9._]{2,30})/);
  if (handle && !out.curator_instagram) out.curator_instagram = handle[1];
  const email = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  if (email) out.curator_email = email[0].toLowerCase();
  const web = text.match(/https?:\/\/(?!open\.spotify|instagram|tiktok|twitter|x\.com|linktr|beacons)[^\s)]+/i);
  if (web) out.curator_website = web[0];
  return out;
}

function contactConfidence(found: Extracted, hadEmail: boolean): number {
  if (found.curator_email && found.curator_instagram) return 8;
  if (found.curator_instagram) return 6;
  if (hadEmail) return 7;
  if (found.curator_linktree || found.curator_website) return 5;
  if (Object.keys(found).length) return 3;
  return 1;
}

async function firecrawlMarkdown(url: string, key: string): Promise<string> {
  const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Firecrawl ${res.status}`);
  return (data as { data?: { markdown?: string }; markdown?: string }).data?.markdown ??
    (data as { markdown?: string }).markdown ?? "";
}

function mergePatch(existing: Record<string, unknown>, found: Extracted): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(found)) {
    if (v == null || v === "") continue;
    const cur = existing[k];
    if (cur != null && String(cur).trim() !== "") continue;
    patch[k] = v;
  }
  return patch;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const expected = Deno.env.get("FANFUEL_HUB_KEY");
    if (!expected || getHubKey(req).trim() !== expected.trim()) {
      return json({ error: "Unauthorized" }, 401);
    }
    const fcKey = Deno.env.get("FIRECRAWL_API_KEY");
    if (!fcKey) return json({ error: "FIRECRAWL_API_KEY not configured" }, 500);

    const body = await req.json().catch(() => ({}));
    const playlistIds = Array.isArray(body.playlist_ids)
      ? body.playlist_ids.map(String).filter(Boolean)
      : [];
    const trackName = String(body.track_name ?? "").trim();
    const limit = Math.min(20, Math.max(1, Number(body.limit) || 10));

    const sb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    let query = sb.from("playlist_targets").select("*").eq("is_active", true);
    if (playlistIds.length) {
      query = query.in("playlist_id", playlistIds.slice(0, 20));
    } else if (trackName) {
      query = query.order("follower_count", { ascending: false, nullsFirst: false });
      if (body.lane) query = query.eq("lane", String(body.lane));
    } else {
      return json({ error: "playlist_ids or track_name required" }, 400);
    }

    const { data: rows, error } = await query.limit(limit);
    if (error) return json({ error: error.message }, 500);
    if (!rows?.length) return json({ ok: true, enriched: 0, fields_added: {} });

    const fieldsAdded: Record<string, number> = {};
    let enriched = 0;

    for (const row of rows) {
      const texts: string[] = [row.playlist_name ?? "", row.curator_name ?? "", row.notes ?? ""];
      const spotifyId = String(row.playlist_id).replace(/^spotify:/, "");
      if (row.platform === "spotify" && spotifyId) {
        try {
          const md = await firecrawlMarkdown(`https://open.spotify.com/playlist/${spotifyId}`, fcKey);
          texts.push(md);
          await sleep(RATE_MS);
        } catch (e) {
          console.error("spotify scrape", row.playlist_id, e);
        }
      }
      const subUrl = (row.submission_url as string | null)?.trim();
      if (subUrl && !subUrl.includes("open.spotify.com/playlist")) {
        try {
          const md = await firecrawlMarkdown(subUrl, fcKey);
          texts.push(md);
          await sleep(RATE_MS);
        } catch (e) {
          console.error("submission scrape", row.playlist_id, e);
        }
      }

      const found = extractContacts(texts.join("\n"));
      const patch = mergePatch(row, found);
      const hadEmail = Boolean((row.curator_email as string | null)?.trim());
      if (Object.keys(patch).length) {
        patch.contact_confidence = contactConfidence(
          { ...found, ...patch } as Extracted,
          hadEmail,
        );
        const { error: upErr } = await sb.from("playlist_targets").update(patch).eq(
          "playlist_id",
          row.playlist_id,
        );
        if (!upErr) {
          enriched++;
          for (const k of Object.keys(patch)) {
            fieldsAdded[k] = (fieldsAdded[k] ?? 0) + 1;
          }
        }
      }
    }

    return json({ ok: true, enriched, fields_added: fieldsAdded });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json({ error: msg }, 500);
  }
});
