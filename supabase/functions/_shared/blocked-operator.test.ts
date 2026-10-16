/**
 * Blocked operator matching: email domain, contact, curator name, and URL
 * against operator groups already marked blocked or pay-to-play.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildBlockedOperatorIndex,
  isBlockedOrInactivePayToPlay,
  matchBlockedOperator,
  type OperatorCandidate,
} from "./blocked-operator.ts";

const GROUPS = [
  {
    playlist_id: "1YuMdtA1WFqr3C9byzPtmZ",
    operator_group_id: "colonizemedia",
    curator_email: "submissions@colonizemedia.com",
    curator_name: "Colonize Media",
    pitch_status: "blocked",
    fraud_verdict: "safe",
    is_active: false,
    submission_cost: "unknown",
    verification_status: "auto_verified",
  },
  {
    playlist_id: "0QQv69piqbBB0Mexcnahyb",
    operator_group_id: "colonizemedia",
    curator_email: "submissions@colonizemedia.com",
    curator_name: "Colonize Media",
    pitch_status: "declined",
    fraud_verdict: "safe",
    is_active: false,
    submission_cost: "unknown",
    verification_status: "auto_verified",
  },
  {
    playlist_id: "1UtqKLhKNxWsMNafBROKWG",
    operator_group_id: "lordvincent",
    curator_email: "lordvincentbusiness@gmail.com",
    curator_name: "LORD VINCENT",
    pitch_status: "pay_to_play",
    fraud_verdict: "safe",
    is_active: false,
    submission_cost: "paid",
  },
  {
    playlist_id: "2j9H3UJI4FgvKhQKHdljnS",
    operator_group_id: "livinginplaylists",
    curator_email: "livinginplaylists@gmail.com",
    curator_name: "Living In Playlists",
    pitch_status: "pay_to_play",
    fraud_verdict: "safe",
    is_active: false,
    submission_cost: "paid",
  },
  {
    playlist_id: "6U8tMyyG7d07qhN6whFPhu",
    operator_group_id: "aisultangm",
    curator_email: null,
    curator_name: "alexrodrigo320",
    ig_curator_account: "aisultangm",
    pitch_status: "pay_to_play",
    fraud_verdict: "safe",
    is_active: false,
    submission_cost: "paid",
  },
  {
    playlist_id: "68318KBrlWlst9mqu3tqLj",
    operator_group_id: "ernesttlovesyou",
    curator_email: "ernesttlovesyou@gmail.com",
    curator_name: "Ernesto GG",
    pitch_status: "pay_to_play",
    fraud_verdict: "safe",
    is_active: false,
    submission_cost: "paid",
  },
  {
    playlist_id: "pump-1",
    operator_group_id: "playlistpumppragency",
    curator_email: "playlistpumppragency@gmail.com",
    curator_name: "Playlist Curator Submission",
    pitch_status: "pitched",
    fraud_verdict: "safe",
    is_active: true,
    submission_cost: "free",
  },
  {
    playlist_id: "promo-1",
    operator_group_id: "promotingsounds",
    curator_email: "hello@promotingsounds.com",
    curator_name: "Promoting Sounds",
    pitch_status: "not_pitched",
    fraud_verdict: "safe",
    is_active: false,
    submission_cost: "free",
  },
];

const index = buildBlockedOperatorIndex(GROUPS);

function match(candidate: OperatorCandidate) {
  return matchBlockedOperator(index, candidate);
}

Deno.test("blocked or pay_to_play status qualifies; inactive alone does not", () => {
  assertEquals(isBlockedOrInactivePayToPlay(GROUPS[0]), true);
  assertEquals(isBlockedOrInactivePayToPlay(GROUPS[1]), false);
  assertEquals(isBlockedOrInactivePayToPlay(GROUPS[2]), true);
  assertEquals(isBlockedOrInactivePayToPlay(GROUPS[6]), false);
  assertEquals(isBlockedOrInactivePayToPlay(GROUPS[7]), false);
  assertEquals(
    isBlockedOrInactivePayToPlay({
      operator_group_id: "paidvendor",
      fraud_verdict: "pay_to_play",
      pitch_status: "not_pitched",
      is_active: false,
    }),
    true,
  );
});

Deno.test("colonizemedia matches email domain, contact, name, and URL", () => {
  assertEquals(
    match({ curatorEmail: "newlist@colonizemedia.com" })?.operator_group_id,
    "colonizemedia",
  );
  assertEquals(
    match({ curatorEmail: "newlist@colonizemedia.com" })?.matched_on,
    "email_domain",
  );
  assertEquals(
    match({ curatorEmail: "submissions@colonizemedia.com" }),
    { operator_group_id: "colonizemedia", matched_on: "email_exact" },
  );
  assertEquals(
    match({ curatorName: "Colonize Media" })?.operator_group_id,
    "colonizemedia",
  );
  assertEquals(
    match({ playlistName: "Colonize Media" })?.operator_group_id,
    "colonizemedia",
  );
  assertEquals(
    match({ formUrl: "https://www.colonizemedia.com/submit" })?.matched_on,
    "url",
  );
  assertEquals(
    match({ sourceUrl: "https://open.spotify.com/playlist/0QQv69piqbBB0Mexcnahyb" })
      ?.operator_group_id,
    "colonizemedia",
  );
});

Deno.test("named pay-to-play groups match contact, local-part, and handle", () => {
  assertEquals(
    match({ curatorEmail: "lordvincentbusiness@gmail.com" }),
    { operator_group_id: "lordvincent", matched_on: "email_exact" },
  );
  assertEquals(
    match({ curatorEmail: "lordvincentofficial@gmail.com" })?.matched_on,
    "email_local",
  );
  assertEquals(match({ curatorName: "LORD VINCENT" })?.operator_group_id, "lordvincent");
  assertEquals(
    match({ curatorEmail: "livinginplaylists@gmail.com" })?.operator_group_id,
    "livinginplaylists",
  );
  assertEquals(match({ igAccount: "@Aisultangm" })?.operator_group_id, "aisultangm");
  assertEquals(
    match({ curatorEmail: "ernesttlovesyou@gmail.com" })?.operator_group_id,
    "ernesttlovesyou",
  );
  assertEquals(match({ curatorName: "Ernesto GG" })?.operator_group_id, "ernesttlovesyou");
});

Deno.test("active and merely-inactive operators are not a blocked match", () => {
  assertEquals(match({ curatorEmail: "playlistpumppragency@gmail.com" }), null);
  assertEquals(match({ curatorEmail: "hello@promotingsounds.com" }), null);
  assertEquals(match({ curatorName: "Promoting Sounds" }), null);
  assertEquals(match({ curatorEmail: "someone@gmail.com", playlistName: "Fresh Rap List" }), null);
});

Deno.test("a declined sibling stays blocked because the group has a blocked row", () => {
  assertEquals(
    match({ playlistId: "0QQv69piqbBB0Mexcnahyb" })?.operator_group_id,
    "colonizemedia",
  );
});
