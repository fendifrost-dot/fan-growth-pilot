// resolve-artwork
//
// Auto-populates a smart link's cover art AND its full multi-platform DSP link
// set from the one streaming page it points to. Two things happen per link:
//   1. Cover art  — highest-res official artwork (Apple 1000 > Spotify 640 >
//      og:image), stored in the smart-links bucket, written to image_url.
//   2. Platform links — the hybrid resolver (Odesli ∪ iTunes ∪ Spotify) fills
//      metadata.{spotify_url, apple_music_url, soundcloud_url, youtube_url,
//      tidal_url}, which the landing page renders as per-DSP buttons.
// Used to auto-fill on link creation and to backfill existing links.
//
// Auth: a valid Supabase user JWT (browser admin) OR the FANFUEL_HUB_KEY header
// (server / cron / backfill).
//
// Body:
//   { slug: string }           resolve one link by slug
//   { linkId: string }         resolve one link by id
//   { backfill: true }         resolve every active link missing image_url
//   { ..., force: true }       re-resolve even if image_url is already set

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  ArtworkResult,
  gatherCandidateUrls,
  resolveArtwork,
} from "../_shared/artwork.ts";
import {
  PLATFORM_METADATA_KEYS,
  resolvePlatformLinks,
} from "../_shared/platform-links.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-api-key",
};

const BUCKET = "smart-links";

function extFor(contentType: string): string {
  if (/png/i.test(contentType)) return "png";
  if (/webp/i.test(contentType)) return "webp";
  return "jpg";
}

interface LinkRow {
  id: string;
  slug: string;
  short_code: string | null;
  image_url: string | null;
  destination_url: string | null;
  metadata: Record<string, unknown> | null;
}

// Resolve the full DSP link set from one pasted URL and merge the results into
// the smart link's metadata as the individual *_url keys the landing page reads.
// Runs independently of the artwork step so links that already have cover art
// still get their platform buttons filled in. Best-effort: never throws.
// Only fills keys that are empty, unless force re-resolves them.
async function resolveAndStorePlatforms(
  supabase: SupabaseClient,
  link: LinkRow,
  force: boolean,
): Promise<string[]> {
  try {
    const candidates = gatherCandidateUrls(link);
    if (candidates.length === 0) return [];
    const resolved = await resolvePlatformLinks(candidates);
    const existing = (link.metadata ?? {}) as Record<string, unknown>;
    const merged = { ...existing };
    const written: string[] = [];
    for (const key of PLATFORM_METADATA_KEYS) {
      const val = resolved[key];
      const cur = existing[key];
      const hasCur = typeof cur === "string" && cur.trim().length > 0;
      if (val && (!hasCur || force)) {
        merged[key] = val;
        written.push(key);
      }
    }
    if (written.length === 0) return [];
    const { error } = await supabase
      .from("smart_links")
      .update({ metadata: merged })
      .eq("id", link.id);
    if (error) {
      console.error(`[resolve-artwork] platform metadata update failed for ${link.slug}:`, error.message);
      return [];
    }
    // Keep the in-memory row current so a subsequent artwork pass sees new URLs.
    link.metadata = merged;
    return written;
  } catch (e) {
    console.error(`[resolve-artwork] platform resolve failed for ${link.slug}:`, e instanceof Error ? e.message : e);
    return [];
  }
}

async function resolveAndStore(
  supabase: SupabaseClient,
  link: LinkRow,
  force: boolean,
): Promise<{ slug: string; status: string; source?: string; image_url?: string; width?: number | null; detail?: string; platforms?: string[] }> {
  // Platform links first — independent of whether artwork already exists.
  const platforms = await resolveAndStorePlatforms(supabase, link, force);

  if (link.image_url && !force) {
    return { slug: link.slug, status: "skipped", detail: "already has artwork", platforms };
  }

  const candidates = gatherCandidateUrls(link);
  if (candidates.length === 0) {
    return { slug: link.slug, status: "no_candidates", detail: "no streaming URLs found", platforms };
  }

  const art: ArtworkResult | null = await resolveArtwork(candidates);
  if (!art) {
    return { slug: link.slug, status: "not_found", detail: "no high-res artwork resolved", platforms };
  }

  // Download the verified image and store it in our own bucket for permanence.
  const imgRes = await fetch(art.imageUrl);
  if (!imgRes.ok) {
    return { slug: link.slug, status: "fetch_failed", detail: `download ${imgRes.status}`, platforms };
  }
  const bytes = new Uint8Array(await imgRes.arrayBuffer());
  const ext = extFor(art.contentType);
  const path = `images/auto/${link.slug}-${link.short_code ?? link.id}.${ext}`;

  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(path, bytes, { contentType: art.contentType, upsert: true });
  if (upErr) {
    return { slug: link.slug, status: "upload_failed", detail: upErr.message, platforms };
  }

  const { error: updErr } = await supabase
    .from("smart_links")
    .update({ image_url: path })
    .eq("id", link.id);
  if (updErr) {
    return { slug: link.slug, status: "db_update_failed", detail: updErr.message, platforms };
  }

  return {
    slug: link.slug,
    status: "updated",
    platforms,
    source: art.source,
    image_url: path,
    width: art.width,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // ── Auth: hub key OR valid user JWT ──
    const hubKey = Deno.env.get("FANFUEL_HUB_KEY");
    const xApiKey = (req.headers.get("x-api-key") || "").trim();
    const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();

    let authorized = false;
    if (hubKey && (xApiKey === hubKey || bearer === hubKey)) {
      authorized = true;
    } else if (bearer) {
      const { data: { user } } = await supabase.auth.getUser(bearer);
      if (user) authorized = true;
    }
    if (!authorized) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json().catch(() => ({}));
    const { slug, linkId, backfill, force } = body as {
      slug?: string;
      linkId?: string;
      backfill?: boolean;
      force?: boolean;
    };

    const SELECT = "id, slug, short_code, image_url, destination_url, metadata";

    if (backfill) {
      const { data, error } = await supabase
        .from("smart_links")
        .select(SELECT)
        .eq("is_active", true)
        .is("image_url", null);
      if (error) throw error;
      const links = (data ?? []) as LinkRow[];
      const results = [];
      for (const link of links) {
        results.push(await resolveAndStore(supabase, link, !!force));
      }
      return new Response(
        JSON.stringify({ mode: "backfill", processed: results.length, results }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (!slug && !linkId) {
      return new Response(
        JSON.stringify({ error: "Provide slug, linkId, or backfill:true" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    let query = supabase.from("smart_links").select(SELECT);
    query = linkId ? query.eq("id", linkId) : query.eq("slug", slug!);
    const { data, error } = await query.maybeSingle();
    if (error) throw error;
    if (!data) {
      return new Response(JSON.stringify({ error: "Smart link not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const result = await resolveAndStore(supabase, data as LinkRow, !!force);
    const httpStatus = result.status === "updated" || result.status === "skipped" ? 200 : 422;
    return new Response(JSON.stringify(result), {
      status: httpStatus,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("resolve-artwork error:", err);
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
