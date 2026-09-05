import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { lanesIntersect } from "./genre-fit.ts";

Deno.test("lanesIntersect matches case-insensitively", () => {
  const m = lanesIntersect(["rap_general", "deep_house_groove"], ["RAP_GENERAL", "pop"]);
  assertEquals(m, ["rap_general"]);
});

Deno.test("lanesIntersect empty when no overlap", () => {
  assertEquals(lanesIntersect(["rap_general"], ["house_club"]), []);
});
