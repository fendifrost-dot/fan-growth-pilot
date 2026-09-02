/**
 * Draft → approve identity wiring tests.
 * Title-only drafts are forbidden; approve_draft must forward track_id + campaign_id.
 */
import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.test("WIRING: runDraftPitch requires track_id + campaign_id before loading playlist", async () => {
  const src = await Deno.readTextFile(new URL("./playlist-agent-run.ts", import.meta.url));
  const fn = src.slice(src.indexOf("export async function runDraftPitch"));
  const end = fn.indexOf("\nexport async function runApproveDraft");
  const body = end > 0 ? fn.slice(0, end) : fn;

  assert(body.includes("draft_pitch requires exact track_id and campaign_id"));
  assert(body.includes("assertSendCampaignIdentity"));
  assert(!body.includes("checkDraftEligibilityByName"), "catalogue-pick title path must stay deleted");
  assert(!body.includes("pickCatalogTrackForPlacement(row, catalog"), "title-only catalogue pick must stay deleted");

  const requireAt = body.indexOf("if (!trackId || !campaignId)");
  const playlistLoadAt = body.indexOf('from("playlist_targets")');
  assert(requireAt > -1 && playlistLoadAt > -1);
  assert(requireAt < playlistLoadAt, "identity required before playlist load");
});

Deno.test("WIRING: runApproveDraft forwards track_id and campaign_id to execute-pitch", async () => {
  const src = await Deno.readTextFile(new URL("./playlist-agent-run.ts", import.meta.url));
  const fn = src.slice(src.indexOf("export async function runApproveDraft"));
  const end = fn.indexOf("\nexport async function ");
  const body = end > 0 ? fn.slice(0, end) : fn;

  assert(body.includes("Draft is missing track_id or campaign_id"));
  assert(body.includes("track_id: sendTrackId"));
  assert(body.includes("campaign_id: sendCampaignId"));

  const missingGate = body.indexOf("if (!sendTrackId || !sendCampaignId)");
  const fetchAt = body.indexOf("execute-pitch");
  assert(missingGate > -1 && fetchAt > -1);
  assert(missingGate < fetchAt, "missing identity must refuse before execute-pitch fetch");
});

Deno.test("WIRING: schedule_follow_up cron passes track_id/campaign_id into draft_pitch", async () => {
  const src = await Deno.readTextFile(new URL("./playlist-agent-run.ts", import.meta.url));
  const fn = src.slice(src.indexOf("export async function runScheduleFollowUp"));
  assert(fn.includes("pitch_log missing track_id/campaign_id"));
  assert(fn.includes("track_id: trackId"));
  assert(fn.includes("campaign_id: campaignId"));
  assert(fn.includes('select("id, playlist_id, track_name, method, track_id, campaign_id")'));
});
