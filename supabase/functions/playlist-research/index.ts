import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-api-key",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    // Accept auth via x-api-key, Authorization: Bearer, or apikey header
    const xApiKey = req.headers.get("x-api-key");
    const authHeader = req.headers.get("authorization");
    const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    const anonApiKey = req.headers.get("apikey");
    const providedKey = (xApiKey || bearerToken || anonApiKey || "").trim();
    const expectedKey = (Deno.env.get("FANFUEL_HUB_KEY") || "").trim();
    if (!expectedKey || !providedKey || providedKey !== expectedKey) {
      console.error("Auth failed", {
        hasExpectedKey: !!expectedKey,
        expectedKeyLen: expectedKey.length,
        providedKeyLen: providedKey.length,
        headerUsed: xApiKey ? "x-api-key" : bearerToken ? "bearer" : anonApiKey ? "apikey" : "none",
      });
      return json({ error: "Unauthorized" }, 401);
    }

    const { track_name } = await req.json();
    if (!track_name) return json({ error: "track_name is required" }, 400);

    const spotifyClientId = Deno.env.get("SPOTIFY_CLIENT_ID");
    const spotifyClientSecret = Deno.env.get("SPOTIFY_CLIENT_SECRET");
    const soundcloudClientId = Deno.env.get("SOUNDCLOUD_CLIENT_ID");

    if (!spotifyClientId || !spotifyClientSecret) {
      return json({ error: "Spotify credentials not configured" }, 500);
    }

    // Get Spotify access token
    const tokenResp = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${spotifyClientId}:${spotifyClientSecret}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    if (!tokenResp.ok) {
      const errText = await tokenResp.text();
      return json({ error: `Spotify token request failed: ${tokenResp.status} - ${errText.slice(0, 200)}` }, 500);
    }
    const { access_token } = await tokenResp.json();

    const spot = async (url: string) => {
      const r = await fetch(url, { headers: { Authorization: `Bearer ${access_token}` } });
      if (!r.ok) {
        const text = await r.text();
        throw new Error(`Spotify API ${r.status}: ${text.slice(0, 200)}`);
      }
      return r.json();
    };

    // Search for track
    const searchData = await spot(
      `https://api.spotify.com/v1/search?q=${encodeURIComponent(track_name)}&type=track&limit=1`
    );
    const track = searchData?.tracks?.items?.[0];
    if (!track) return json({ error: `Track "${track_name}" not found on Spotify` }, 404);

    const trackId = track.id;
    const artistId = track.artists[0].id;

    // audio-features and recommendations endpoints are deprecated (Nov 2024)
    const audioFeatures = null;

    // Get artist details (for genres) and related artists
    const [artistData, relatedData] = await Promise.all([
      spot(`https://api.spotify.com/v1/artists/${artistId}`),
      spot(`https://api.spotify.com/v1/artists/${artistId}/related-artists`),
    ]);

    const artistGenres: string[] = artistData?.genres || [];
    const relatedArtists = (relatedData?.artists || []).slice(0, 10);

    // Build neighborhood artists from related artists
    const neighborhoodArtists = new Map<string, string>();
    for (const a of relatedArtists) {
      if (!neighborhoodArtists.has(a.id)) neighborhoodArtists.set(a.id, a.name);
    }
    // Also add genres as pseudo-entries for playlist search diversity
    const genreSearchTerms = artistGenres.slice(0, 5);

    // Search for playlists using related artist names AND genre terms
    const playlistMap = new Map<string, any>();
    const artistSearchEntries = Array.from(neighborhoodArtists.entries()).slice(0, 15);
    const allSearchTerms = [
      ...artistSearchEntries.map(([, name]) => name),
      ...genreSearchTerms,
    ];
    await Promise.all(
      allSearchTerms.map(async (searchTerm) => {
        try {
          const data = await spot(
            `https://api.spotify.com/v1/search?q=${encodeURIComponent(searchTerm)}&type=playlist&limit=5`
          );
          for (const pl of data?.playlists?.items || []) {
            if (!pl?.id) continue;
            const key = `spotify:${pl.id}`;
            if (playlistMap.has(key)) {
              playlistMap.get(key).matched_artists.push(searchTerm);
            } else {
              playlistMap.set(key, {
                playlist_id: key,
                platform: "spotify",
                playlist_name: pl.name,
                curator_name: pl.owner?.display_name || null,
                follower_count: pl.followers?.total || 0,
                track_count: pl.tracks?.total || 0,
                matched_artists: [searchTerm],
                external_url: pl.external_urls?.spotify || null,
              });
            }
          }
        } catch (e) {
          console.error("Spotify search error:", e);
        }
      })
    );

    // Search for playlists on SoundCloud
    if (soundcloudClientId) {
      const scEntries = Array.from(neighborhoodArtists.entries()).slice(0, 10);
      await Promise.all(
        scEntries.map(async ([, artistName]) => {
          try {
            const resp = await fetch(
              `https://api.soundcloud.com/playlists?q=${encodeURIComponent(artistName)}&limit=5&client_id=${soundcloudClientId}`
            );
            const data = await resp.json();
            const playlists = Array.isArray(data) ? data : data?.collection || [];
            for (const pl of playlists) {
              if (!pl?.id) continue;
              const key = `soundcloud:${pl.id}`;
              if (playlistMap.has(key)) {
                playlistMap.get(key).matched_artists.push(artistName);
              } else {
                playlistMap.set(key, {
                  playlist_id: key,
                  platform: "soundcloud",
                  playlist_name: pl.title,
                  curator_name: pl.user?.username || null,
                  follower_count: 0,
                  track_count: pl.track_count || 0,
                  matched_artists: [artistName],
                  external_url: pl.permalink_url || null,
                });
              }
            }
          } catch (e) {
            console.error("SoundCloud search error:", e);
          }
        })
      );
    }

    // Build research context
    const research_context = {
      audio_features: { tempo: audioFeatures?.tempo, energy: audioFeatures?.energy, danceability: audioFeatures?.danceability, valence: audioFeatures?.valence },
      neighborhood_artists: Object.fromEntries(neighborhoodArtists),
      related_artists: relatedArtists.map((a: any) => ({ id: a.id, name: a.name })),
    };

    // Score and rank playlists
    const results: any[] = [];
    for (const pl of playlistMap.values()) {
      let overlapScore = 0;
      overlapScore += pl.matched_artists.length * 20;
      if (pl.follower_count > 500) overlapScore += 40;

      let fraudScore = 0;
      if (pl.follower_count > 10000 && pl.follower_count % 1000 === 0) fraudScore += 20;
      if (["promotion", "promo", "placement", "guaranteed", "pay"].some((k: string) => pl.playlist_name?.toLowerCase().includes(k))) fraudScore += 35;
      if (pl.track_count > 500) fraudScore += 25;
      if (/\d{4,}/.test(pl.playlist_name)) fraudScore += 30;

      results.push({
        ...pl,
        overlap_score: overlapScore,
        fraud_score: fraudScore,
        fraud_verdict: fraudScore >= 30 ? "suspicious" : "safe",
        track_name,
        pitch_status: "not_pitched",
        research_context,
      });
    }

    results.sort((a, b) => b.overlap_score - a.overlap_score);
    const top = results.slice(0, 50);

    // Upsert to database
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { error } = await supabase.from("playlist_targets").upsert(
      top.map((pl) => ({
        playlist_id: pl.playlist_id,
        platform: pl.platform,
        playlist_name: pl.playlist_name,
        curator_name: pl.curator_name,
        track_name,
        follower_count: pl.follower_count,
        track_count: pl.track_count,
        overlap_score: pl.overlap_score,
        fraud_score: pl.fraud_score,
        fraud_verdict: pl.fraud_verdict,
        pitch_status: pl.pitch_status,
        research_context: pl.research_context,
        updated_at: new Date().toISOString(),
      })),
      { onConflict: "playlist_id" }
    );

    if (error) console.error("Upsert error:", error);

    return json({
      track: { id: trackId, name: track.name, artist: track.artists[0].name },
      audio_features: research_context.audio_features,
      playlists_found: top.length,
      top_playlists: top.slice(0, 10).map((p) => ({
        playlist_id: p.playlist_id,
        playlist_name: p.playlist_name,
        platform: p.platform,
        overlap_score: p.overlap_score,
        fraud_verdict: p.fraud_verdict,
      })),
    });
  } catch (err) {
    console.error("playlist-research error:", err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
