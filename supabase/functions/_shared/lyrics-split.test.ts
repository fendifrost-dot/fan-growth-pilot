import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { DeferredLyricsProvider, runLyricsAction } from "./lyrics.ts";
import { computeSplitActionItems, renderSplitSheetHtml, runSplitSheetAction } from "./split-sheets.ts";
import type { Actor } from "./outreach-auth.ts";

const admin: Actor = { kind: "user", userId: "fendi-admin", isAdmin: true };

Deno.test("DeferredLyricsProvider always refuses", async () => {
  const p = new DeferredLyricsProvider();
  const r = await p.requestTranscription({ trackId: "t1" });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, "provider_deferred");
});

Deno.test("request_lyrics_provider_job returns 501 deferred", async () => {
  // deno-lint-ignore no-explicit-any
  const sb: any = { from: () => ({}) };
  const r = await runLyricsAction(
    "request_lyrics_provider_job",
    { track_id: "t1" },
    sb,
    admin,
  );
  assertEquals(r.status, 501);
});

Deno.test("computeSplitActionItems and HTML generator work with incomplete data", () => {
  const items = computeSplitActionItems([{ legal_name: null, role: "writer", split_percent: null }]);
  assertEquals(items.length > 0, true);
  const html = renderSplitSheetHtml({
    trackName: "Meditate",
    contributors: [{ legal_name: null, role: "writer", split_percent: null }],
    actionItems: items,
    generatedAt: "2026-09-02T00:00:00Z",
  });
  assertEquals(html.includes("Action items"), true);
  assertEquals(html.includes("TBD"), true);
});

Deno.test("create_split_sheet requires admin", async () => {
  // deno-lint-ignore no-explicit-any
  const sb: any = {
    from: () => ({
      select: () => ({
        eq: () => ({
          order: () => ({
            limit: () => ({
              maybeSingle: () => Promise.resolve({ data: null, error: null }),
            }),
          }),
          maybeSingle: () => Promise.resolve({ data: { id: "t1", name: "Meditate" }, error: null }),
        }),
      }),
      insert: () => ({
        select: () => ({
          single: () =>
            Promise.resolve({
              data: { id: "s1", track_id: "t1", version_number: 1 },
              error: null,
            }),
        }),
      }),
    }),
  };
  const denied = await runSplitSheetAction("create_split_sheet", { track_id: "t1" }, sb, null);
  assertEquals(denied.status, 401);
});
