/**
 * DNA ↔ playlist genre-fit for every playlist send route.
 * Uses approved Song DNA lanes (slugs) vs playlist_categories → categories.slug.
 * Fail-closed when DNA has approved_lanes but playlist has conflicting categories.
 * If playlist has zero categories, refuse (unknown lane = not fit) once DNA is present.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

export type GenreFitOk = { ok: true; matched: string[] };
export type GenreFitFail = { ok: false; error: string; dnaLanes: string[]; playlistLanes: string[] };

export function lanesIntersect(dnaLanes: string[], playlistLanes: string[]): string[] {
  const dna = new Set(dnaLanes.map((s) => s.trim().toLowerCase()).filter(Boolean));
  return playlistLanes
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s && dna.has(s));
}

export async function assertDnaPlaylistGenreFit(
  sb: SupabaseClient,
  opts: { campaignId: string; playlistId: string },
): Promise<GenreFitOk | GenreFitFail> {
  const { data: campaign, error: cErr } = await sb
    .from("pitch_campaigns")
    .select("id, song_dna_version_id, configuration_snapshot")
    .eq("id", opts.campaignId)
    .maybeSingle();
  if (cErr || !campaign) {
    return {
      ok: false,
      error: "Campaign not found for genre-fit check",
      dnaLanes: [],
      playlistLanes: [],
    };
  }

  let dnaLanes: string[] = [];
  const snap = (campaign.configuration_snapshot ?? {}) as Record<string, unknown>;
  if (Array.isArray(snap.approved_lanes)) {
    dnaLanes = snap.approved_lanes as string[];
  } else {
    const snapDna = snap.dna as Record<string, unknown> | undefined;
    if (Array.isArray(snapDna?.approved_lanes)) {
      dnaLanes = snapDna!.approved_lanes as string[];
    }
  }

  if (campaign.song_dna_version_id) {
    const { data: dna } = await sb
      .from("song_dna_versions")
      .select("approved_lanes, excluded_lanes, approval_state")
      .eq("id", campaign.song_dna_version_id)
      .maybeSingle();
    if (dna && String(dna.approval_state) === "approved") {
      dnaLanes = (dna.approved_lanes as string[]) ?? dnaLanes;
      const excluded = new Set(
        ((dna.excluded_lanes as string[]) ?? []).map((s) => s.toLowerCase()),
      );
      const { data: pcs } = await sb
        .from("playlist_categories")
        .select("category_id, categories(slug)")
        .eq("playlist_id", opts.playlistId);
      const playlistLanes = ((pcs ?? []) as { categories: { slug?: string } | null }[])
        .map((r) => r.categories?.slug ?? "")
        .filter(Boolean);

      if (playlistLanes.some((l) => excluded.has(l.toLowerCase()))) {
        return {
          ok: false,
          error: "Playlist lane is on Song DNA excluded_lanes — send refused",
          dnaLanes,
          playlistLanes,
        };
      }
    }
  }

  if (dnaLanes.length === 0) {
    return {
      ok: false,
      error: "Active campaign Song DNA has no approved_lanes — cannot prove genre fit",
      dnaLanes: [],
      playlistLanes: [],
    };
  }

  const { data: pcs, error: pErr } = await sb
    .from("playlist_categories")
    .select("category_id, categories(slug)")
    .eq("playlist_id", opts.playlistId);
  if (pErr) {
    return {
      ok: false,
      error: `Playlist category lookup failed: ${pErr.message}`,
      dnaLanes,
      playlistLanes: [],
    };
  }
  const playlistLanes = ((pcs ?? []) as { categories: { slug?: string } | null }[])
    .map((r) => r.categories?.slug ?? "")
    .filter(Boolean);

  if (playlistLanes.length === 0) {
    return {
      ok: false,
      error: "Playlist has no categories — genre fit cannot be verified (fail-closed)",
      dnaLanes,
      playlistLanes: [],
    };
  }

  const matched = lanesIntersect(dnaLanes, playlistLanes);
  if (matched.length === 0) {
    return {
      ok: false,
      error: `No genre-fit: DNA lanes [${dnaLanes.join(", ")}] vs playlist [${playlistLanes.join(", ")}]`,
      dnaLanes,
      playlistLanes,
    };
  }
  return { ok: true, matched };
}
