// resolve-artwork
//
// Auto-populates a smart link's cover art from the streaming page it points to
// (Spotify / Apple Music / etc.), stores it in the smart-links bucket, and sets
// image_url. Used to auto-fill artwork on link creation and to backfill links
// that are missing art.
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

async function resolveAndStore(
  supabase: SupabaseClient,
  link: LinkRow,
  force: boolean,
): Promise<{ slug: string; status: string; source?: string; image_url?: string; width?: number | null; detail?: string }> {
  if (link.image_url && !force) {
    return { slug: link.slug, status: "skipped", detail: "already has artwork" };
  }

  const candidates = gatherCandidateUrls(link);
  if (candidates.length === 0) {
    return { slug: link.slug, status: "no_candidates", detail: "no streaming URLs found" };
  }

  const art: ArtworkResult | null = await resolveArtwork(candidates);
  if (!art) {
    return { slug: link.slug, status: "not_found", detail: "no high-res artwork resolved" };
  }

  // Download the verified image and store it in our own bucket for permanence.
  const imgRes = await fetch(art.imageUrl);
  if (!imgRes.ok) {
    return { slug: link.slug, status: "fetch_failed", detail: `download ${imgRes.status}` };
  }
  const bytes = new Uint8Array(await imgRes.arrayBuffer());
  const ext = extFor(art.contentType);
  const path = `images/auto/${link.slug}-${link.short_code ?? link.id}.${ext}`;

  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(path, bytes, { contentType: art.contentType, upsert: true });
  if (upErr) {
    return { slug: link.slug, status: "upload_failed", detail: upErr.message };
  }

  const { error: updErr } = await supabase
    .from("smart_links")
    .update({ image_url: path })
    .eq("id", link.id);
  if (updErr) {
    return { slug: link.slug, status: "db_update_failed", detail: updErr.message };
  }

  return {
    slug: link.slug,
    status: "updated",
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
