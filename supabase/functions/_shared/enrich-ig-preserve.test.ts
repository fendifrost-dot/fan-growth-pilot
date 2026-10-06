import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { enrichSpotifyId, hasPreservedIgRoute } from "./playlist-agent-run.ts";

Deno.test("enrich: current bare Spotify ids are enriched (no longer skipped as non_spotify_prefix)", () => {
  assertEquals(enrichSpotifyId("7wwEsgbbm0l9aNHz3IUxWw"), { id: "7wwEsgbbm0l9aNHz3IUxWw", sfa: false });
  assertEquals(enrichSpotifyId("spotify:7wwEsgbbm0l9aNHz3IUxWw"), { id: "7wwEsgbbm0l9aNHz3IUxWw", sfa: false });
  assertEquals(enrichSpotifyId("https://open.spotify.com/playlist/7wwEsgbbm0l9aNHz3IUxWw?si=x"), { id: "7wwEsgbbm0l9aNHz3IUxWw", sfa: false });
  assertEquals(enrichSpotifyId("spotify:sfa:Some Playlist"), { id: "sfa:Some Playlist", sfa: true });
  assertEquals(enrichSpotifyId("url:https://soundplate.com/x"), null);
  assertEquals(enrichSpotifyId("route-abc123"), null);
  assertEquals(enrichSpotifyId(null), null);
});

Deno.test("enrich: IG-only curators with a working IG route are preserved", () => {
  assert(hasPreservedIgRoute({ ig_curator_account: "@rapcurator", path_verified: true, contact_method: "instagram_dm" }));
  assert(hasPreservedIgRoute({ curator_instagram: "rapcurator", path_verified: false, submission_method: "instagram_dm" }));
  assert(!hasPreservedIgRoute({ ig_curator_account: null, curator_instagram: null, path_verified: true }));
  assert(!hasPreservedIgRoute({ ig_curator_account: "not a handle!", path_verified: true }));
  assert(!hasPreservedIgRoute({ curator_instagram: "rapcurator", path_verified: false, contact_method: "email" }));
});
