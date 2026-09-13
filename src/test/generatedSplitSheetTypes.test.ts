import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const TYPES = join(process.cwd(), "src/integrations/supabase/types.ts");

describe("generated supabase types — split-sheet stack", () => {
  it("keeps required tables and track provenance columns", () => {
    expect(existsSync(TYPES)).toBe(true);
    const src = readFileSync(TYPES, "utf8");
    for (const token of [
      "split_sheet_master_owners:",
      "split_sheet_evidence:",
      "split_sheet_deliveries:",
      "rights_document_audit_events:",
      "splits_ready:",
      "splits_ready_legacy:",
      "splits_ready_source:",
      "current_split_sheet_id:",
      "split_sheet_delivery_policy:",
    ]) {
      expect(src, token).toContain(token);
    }
  });
});
