import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  BOT_RISK_THRESHOLD,
  classifyFeel,
  CLASSIFIER_VERSION,
  computeBotRisk,
  enrichmentOutcome,
  FEEL_MIN_CONFIDENCE,
  isClassifierStale,
  laneForSweep,
  resolveSweepGenre,
} from "./playlist-sweep.ts";

// --- bot_risk: known-bot fixtures ------------------------------------------

Deno.test("computeBotRisk flags a Spotify editorial playlist as high-risk", () => {
  const { bot_risk, reasons } = computeBotRisk({
    playlist_id: "spotify:37i9dQZF1DX0XUsuxWHRQd",
    name: "RapCaviar",
    description: "The world's biggest hip-hop playlist.",
    owner: "Spotify",
    owner_id: "spotify",
    followers: 15_000_000,
    track_count: 50,
  });
  assertEquals(bot_risk! >= BOT_RISK_THRESHOLD, true, `editorial should exceed threshold, got ${bot_risk}`);
  assertEquals(reasons.includes("editorial_prefix"), true);
});

Deno.test("computeBotRisk flags a nameless, ownerless, empty playlist", () => {
  const { bot_risk, reasons } = computeBotRisk({
    playlist_id: "spotify:abc123",
    name: "Playlist a1b2c3",
    description: "",
    owner: "",
    owner_id: "",
    followers: 5000,
    track_count: 0,
  });
  // missing_identity(25) + generic_name(20) + empty_description(10) + followers_without_tracks(15) = 70
  assertEquals(bot_risk! >= BOT_RISK_THRESHOLD, true, `got ${bot_risk}`);
  assertEquals(reasons.includes("missing_identity"), true);
  assertEquals(reasons.includes("generic_name"), true);
  assertEquals(reasons.includes("followers_without_tracks"), true);
});

Deno.test("computeBotRisk flags an implausible follower:track ratio", () => {
  const { reasons } = computeBotRisk({
    playlist_id: "spotify:xyz",
    name: "Fresh Trap Bangers",
    description: "Weekly trap picks.",
    owner: "beatplug",
    owner_id: "beatplug",
    followers: 800_000,
    track_count: 10, // 80k followers/track
  });
  assertEquals(reasons.includes("implausible_follower_track_ratio"), true);
});

// --- bot_risk: known-good fixtures -----------------------------------------

Deno.test("computeBotRisk keeps a real independent curator low-risk", () => {
  const { bot_risk } = computeBotRisk({
    playlist_id: "spotify:realcurator1",
    name: "Underground Boom Bap Weekly",
    description: "Handpicked boom bap gems, updated every Friday by a lifelong crate digger.",
    owner: "cratedigger",
    owner_id: "cratedigger",
    followers: 12_000,
    track_count: 90,
  });
  assertEquals(bot_risk! < BOT_RISK_THRESHOLD, true, `real curator should be low-risk, got ${bot_risk}`);
});

Deno.test("computeBotRisk never exceeds 100 and never throws on partial data", () => {
  const { bot_risk } = computeBotRisk({});
  assertEquals(bot_risk !== null && bot_risk >= 0 && bot_risk <= 100, true);
});

// --- bot_risk: un-enriched rows must NOT accrue missing-data penalties ------

Deno.test("computeBotRisk defers scoring for an un-enriched row (no false penalties)", () => {
  // This is the exact shape of a web-search stub that was persisted before the
  // detail scrape ran: placeholder name, no owner, no description, followers 0.
  // Before the fix this scored 35 (missing_identity 25 + empty_description 10) —
  // a false bot signal. It must now defer to a pending (null) score instead.
  const { bot_risk, reasons } = computeBotRisk({
    playlist_id: "spotify:0KLdaPa1b2c3d4e5f6g7h8",
    name: "Playlist 0KLdaP…",
    description: "",
    owner: "",
    owner_id: "",
    followers: null,
    track_count: null,
    enriched: false,
  });
  assertEquals(bot_risk, null, "un-enriched row must have a pending (null) bot_risk");
  assertEquals(reasons.includes("missing_identity"), false);
  assertEquals(reasons.includes("empty_or_boilerplate_description"), false);
  assertEquals(reasons.includes("generic_name"), false);
  assertEquals(reasons.includes("followers_without_tracks"), false);
});

Deno.test("computeBotRisk scores the SAME row normally once it is enriched", () => {
  // Same id, now enriched with real metadata: a legitimate independent curator.
  const { bot_risk } = computeBotRisk({
    playlist_id: "spotify:0KLdaPa1b2c3d4e5f6g7h8",
    name: "Late Night Boom Bap",
    description: "Handpicked lyrical cuts, updated every Friday.",
    owner: "cratedigger",
    owner_id: "cratedigger",
    followers: 8_000,
    track_count: 70,
    enriched: true,
  });
  assertEquals(bot_risk !== null && bot_risk < BOT_RISK_THRESHOLD, true, `got ${bot_risk}`);
});

Deno.test("computeBotRisk still fires empty_description for an ENRICHED row that truly has none", () => {
  // Enriched (we have real name + owner) but the curator left no description —
  // that IS a (weak) real signal and must still fire, unlike the un-enriched case.
  const { reasons } = computeBotRisk({
    playlist_id: "spotify:realbutbare000000000",
    name: "Trap Heat",
    description: "",
    owner: "plugmusic",
    owner_id: "plugmusic",
    followers: 4_000,
    track_count: 40,
    enriched: true,
  });
  assertEquals(reasons.includes("empty_or_boilerplate_description"), true);
});

// --- feel classifier: known-good buckets -----------------------------------

Deno.test("classifyFeel buckets a workout playlist as gym_workout", () => {
  const { category } = classifyFeel(
    "Gym Rap Workout Motivation",
    "Hard hitting tracks for the gym and heavy lifting sessions.",
    ["trap"],
  );
  assertEquals(category, "gym_workout");
});

Deno.test("classifyFeel buckets a late-night lofi playlist as late_night_chill", () => {
  const { category } = classifyFeel(
    "Late Night Lofi Chill",
    "Mellow lo-fi and deep house to unwind after hours.",
    ["deep house"],
  );
  assertEquals(category, "late_night_chill");
});

Deno.test("classifyFeel buckets a club playlist as party_house", () => {
  const { category } = classifyFeel(
    "Weekend Tech House Party",
    "Peak time club and dancefloor bangers for the rave.",
    ["tech house"],
  );
  assertEquals(category, "party_house");
});

Deno.test("classifyFeel returns confidence in [0,1]", () => {
  const { confidence } = classifyFeel("Hype Turnt Bangers", "Turn up energy", []);
  assertEquals(confidence >= 0 && confidence <= 1, true);
});

// --- feel classifier: fallback ---------------------------------------------

Deno.test("classifyFeel falls back to uncategorized on no signal", () => {
  const { category, confidence } = classifyFeel("Playlist 42", "", []);
  assertEquals(category, "uncategorized");
  assertEquals(confidence, 0);
});

Deno.test("classifyFeel falls back to uncategorized when the leader is too weak", () => {
  // One weak signal split against noise should land under FEEL_MIN_CONFIDENCE.
  const res = classifyFeel("Random Mix", "", []);
  assertEquals(res.category, "uncategorized");
  assertEquals(res.confidence < FEEL_MIN_CONFIDENCE, true);
});

// --- enriched classifier: rap/house playlists that name no mood --------------

Deno.test("classifyFeel: a rap-name-only playlist is NOT forced into a mood (regression)", () => {
  // "Hip Hop: Essentials" / "Hip Hop Rotation" used to land in late_night_chill.
  // With only "this is rap" as signal, it must fall to the neutral rap_general
  // bucket — never a mood the data doesn't evidence.
  for (const nm of ["Hip Hop: Essentials", "Hip Hop Rotation", "RAP MUSIC 2026"]) {
    const res = classifyFeel(nm, "", [], []);
    assertEquals(res.category !== "late_night_chill", true, `${nm} must not be late_night_chill`);
    assertEquals(res.category, "rap_general", `${nm} should be rap_general, got ${res.category}`);
  }
});

Deno.test("classifyFeel: an underground rap name resolves to rap_general, not uncategorized", () => {
  const res = classifyFeel("Best Underground Rap 2026", "", [], []);
  assertEquals(res.category, "rap_general");
});

Deno.test("classifyFeel: high-energy rap subgenre cues → hype", () => {
  const res = classifyFeel("Trap Bangers 2026", "The hardest trap and drill to turn up to.", [], []);
  assertEquals(res.category, "hype");
});

Deno.test("classifyFeel: known trap artist names push a neutral rap name to hype", () => {
  const res = classifyFeel("Rap Rotation", "", ["Playboi Carti", "Ken Carson", "Yeat"], []);
  assertEquals(res.category, "hype");
});

Deno.test("classifyFeel: a deep-house description lands in party_house or late_night_chill", () => {
  const res = classifyFeel(
    "Deep House Sessions",
    "Soulful deep house grooves for late night and after hours.",
    [],
    [],
  );
  assertEquals(res.category === "party_house" || res.category === "late_night_chill", true, res.category);
});

Deno.test("classifyFeel: a house name with no mood resolves to house_general", () => {
  const res = classifyFeel("Electronic House Selection", "", [], []);
  assertEquals(res.category, "house_general");
});

Deno.test("classifyFeel: empty signal → uncategorized (confidence 0)", () => {
  const res = classifyFeel("", "", [], []);
  assertEquals(res.category, "uncategorized");
  assertEquals(res.confidence, 0);
});

Deno.test("classifyFeel: always returns a non-empty reason string", () => {
  for (const res of [
    classifyFeel("Trap Bangers", "", [], []),
    classifyFeel("Hip Hop Rotation", "", [], []),
    classifyFeel("", "", [], []),
  ]) {
    assertEquals(typeof res.reason, "string");
    assertEquals(res.reason.length > 0, true);
  }
});

// --- RC2 regression: bare genre names must NOT map to a mood -------------------

Deno.test("classifyFeel: 'Hip Hop: Essentials' (name only) → rap_general, never late_night_chill", () => {
  const res = classifyFeel("Hip Hop: Essentials", "", [], []);
  assertEquals(res.category, "rap_general");
  assertEquals(res.category !== "late_night_chill", true);
});

Deno.test("classifyFeel: 'DEEP HOUSE - TOP 50' → house_general, never late_night_chill (bare genre is not a chill mood)", () => {
  const res = classifyFeel("DEEP HOUSE - TOP 50", "", [], []);
  assertEquals(res.category, "house_general", `got ${res.category} (${res.reason})`);
  assertEquals(res.category !== "late_night_chill", true);
});

Deno.test("classifyFeel: bare 'Deep House 2026' does NOT become late_night_chill on a lone 'slow' token", () => {
  // The only chill-ish token is the weak modifier "slow"; with "deep house" no longer
  // a mood cue, this must resolve to the neutral house bucket, not chill@conf1.
  const res = classifyFeel("Deep House 2026", "slow rolling grooves", [], []);
  assertEquals(res.category !== "late_night_chill", true, `got ${res.category} (${res.reason})`);
  assertEquals(res.category, "house_general");
});

Deno.test("classifyFeel: a genuine lofi/sleep description → late_night_chill", () => {
  const res = classifyFeel(
    "Overnight Study Room",
    "Mellow lofi beats for sleep, study and rainy late night sessions.",
    [],
    [],
  );
  assertEquals(res.category, "late_night_chill", `got ${res.category} (${res.reason})`);
});

Deno.test("classifyFeel: 'RAP MUSIC 2026 Best Rap/Trap/Hits' → hype (trap), not uncategorized/chill", () => {
  const res = classifyFeel("RAP MUSIC 2026 Best Rap/Trap/Hits", "", [], []);
  assertEquals(res.category, "hype", `got ${res.category} (${res.reason})`);
});

Deno.test("classifyFeel: a lone weak modifier 'slow' in a name does not force a mood at conf 1", () => {
  const res = classifyFeel("Slow", "", [], []);
  // No defining cue, no genre → uncategorized (NOT late_night_chill@1).
  assertEquals(res.category !== "late_night_chill", true, `got ${res.category} (${res.reason})`);
});

// --- RC1: stale-classifier detection (drives the re-classify pass) -------------

Deno.test("isClassifierStale: a row stamped with an OLDER classifier_version is flagged stale", () => {
  assertEquals(isClassifierStale(CLASSIFIER_VERSION - 1), true);
  assertEquals(isClassifierStale(1), true, "v1 rows must be re-classified once version advanced");
});

Deno.test("isClassifierStale: a missing/absent version (the old reason=None rows) is stale", () => {
  assertEquals(isClassifierStale(null), true);
  assertEquals(isClassifierStale(undefined), true);
  assertEquals(isClassifierStale(""), true);
  assertEquals(isClassifierStale("not-a-number"), true);
});

Deno.test("isClassifierStale: a row already at the CURRENT version is NOT stale (idempotent no-op)", () => {
  assertEquals(isClassifierStale(CLASSIFIER_VERSION), false);
  assertEquals(isClassifierStale(String(CLASSIFIER_VERSION)), false);
});

// --- RC3: honest dead-playlist verdict ----------------------------------------

Deno.test("enrichmentOutcome: no entity at all → dead, not enriched (never backfilled_ok)", () => {
  const v = enrichmentOutcome(/* hasEntity */ false, /* hasRealName */ false);
  assertEquals(v.dead, true);
  assertEquals(v.enriched, false);
  assertEquals(v.reason, "no_metadata");
});

Deno.test("enrichmentOutcome: entity rendered but no name → retryable, NOT dead", () => {
  const v = enrichmentOutcome(true, false);
  assertEquals(v.dead, false);
  assertEquals(v.enriched, false);
  assertEquals(v.reason, "no_name");
});

Deno.test("enrichmentOutcome: real name recovered → enriched, counts as backfilled_ok", () => {
  const v = enrichmentOutcome(true, true);
  assertEquals(v.enriched, true);
  assertEquals(v.dead, false);
});

// --- genre + sweep-lane derivation (Problem 2: rap must be a real lane) -----

Deno.test("classifyFeel: a rap record resolves genre=rap (not house)", () => {
  const trap = classifyFeel("Trap Bangers 2026", "hardest trap and drill", [], []);
  assertEquals(trap.genre, "rap");
  const conscious = classifyFeel("Conscious Boom Bap", "lyrical real hip hop", [], []);
  assertEquals(conscious.genre, "rap");
});

Deno.test("classifyFeel: a house record resolves genre=house (not rap)", () => {
  const dh = classifyFeel("DEEP HOUSE - TOP 50", "", [], []);
  assertEquals(dh.genre, "house");
  const club = classifyFeel("Club House Party", "peak time rave dancefloor", [], []);
  assertEquals(club.genre, "house");
});

Deno.test("classifyFeel: no genre signal → genre=null (left unlaned, never guessed)", () => {
  assertEquals(classifyFeel("Playlist 42", "", [], []).genre, null);
  // A pure gym mood with no genre token is genuinely ambiguous.
  assertEquals(classifyFeel("Workout Pump", "cardio hiit sweat", [], []).genre, null);
});

Deno.test("resolveSweepGenre: rap-led tiebreak when both signals present", () => {
  assertEquals(resolveSweepGenre(true, true, "uncategorized"), "rap");
  assertEquals(resolveSweepGenre(false, false, "hype"), "rap"); // rap mood alone
  assertEquals(resolveSweepGenre(false, false, "party_house"), "house"); // house mood alone
  assertEquals(resolveSweepGenre(false, false, "gym_workout"), null); // ambiguous mood
});

Deno.test("laneForSweep: rap moods map to distinct, working rap lanes", () => {
  assertEquals(laneForSweep("hype", "rap"), "rap_trap_hype");
  assertEquals(laneForSweep("introspective", "rap"), "rap_conscious");
  assertEquals(laneForSweep("rap_general", "rap"), "rap_general");
  assertEquals(laneForSweep("feel_good", "rap"), "rap_general"); // any other rap → general
});

Deno.test("laneForSweep: house maps to house lanes; null genre stays unlaned", () => {
  assertEquals(laneForSweep("party_house", "house"), "house_club");
  assertEquals(laneForSweep("house_general", "house"), "house_general");
  assertEquals(laneForSweep("late_night_chill", "house"), "house_general");
  assertEquals(laneForSweep("gym_workout", null), null);
});

Deno.test("end-to-end: a rap playlist lands in a rap lane, a house one in a house lane", () => {
  const rap = classifyFeel("RAP MUSIC 2026 Best Rap/Trap/Hits", "", [], []);
  const rapLane = laneForSweep(rap.category, rap.genre);
  assertEquals(rapLane?.startsWith("rap_"), true);

  const house = classifyFeel("Soulful Deep House Grooves", "", [], []);
  const houseLane = laneForSweep(house.category, house.genre);
  assertEquals(houseLane?.startsWith("house_"), true);
});

Deno.test("CLASSIFIER_VERSION bumped to 3 (genre-aware) so prior sweep rows re-classify", () => {
  assertEquals(CLASSIFIER_VERSION >= 3, true);
});
