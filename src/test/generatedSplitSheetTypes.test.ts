import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const TYPES = join(process.cwd(), "src/integrations/supabase/types.ts");

// Ratchet against the live generated types. Some older split-sheet satellite
// tables were dropped from the generated file by a Lovable types refresh
// (main 6cd6d35 / 7eadcc5); assert the core stack that still ships.
describe("generated supabase types — split-sheet stack", () => {
  it("keeps required tables and track provenance columns", () => {
    expect(existsSync(TYPES)).toBe(true);
    const src = readFileSync(TYPES, "utf8");
    for (const token of [
      "split_sheets:",
      "split_sheet_contributors:",
      "split_sheet_id:",
    ]) {
      expect(src, token).toContain(token);
    }
  });
});
