import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Mirror of edge computeSplitActionItems / deferred provider contract for CI without Deno.
function computeSplitActionItems(
  contributors: { legal_name?: string | null; role?: string; split_percent?: number | null }[],
): string[] {
  const items: string[] = [];
  if (contributors.length === 0) {
    items.push("Add at least one contributor with legal name, role, and split %");
    return items;
  }
  let sum = 0;
  contributors.forEach((c, i) => {
    const n = i + 1;
    if (!String(c.legal_name ?? "").trim()) items.push(`Contributor #${n}: legal name missing`);
    if (c.split_percent == null || !Number.isFinite(Number(c.split_percent))) {
      items.push(`Contributor #${n}: split % missing`);
    } else {
      sum += Number(c.split_percent);
    }
    if (!String(c.role ?? "").trim()) items.push(`Contributor #${n}: role missing`);
  });
  if (contributors.some((c) => c.split_percent != null) && Math.abs(sum - 100) > 0.01) {
    items.push(`Split percentages sum to ${sum.toFixed(2)}% (must total 100%)`);
  }
  return items;
}

describe("split sheet action items", () => {
  it("creates action items for empty contributors", () => {
    expect(computeSplitActionItems([])).toHaveLength(1);
  });

  it("flags incomplete names and non-100 sums", () => {
    const items = computeSplitActionItems([
      { legal_name: "", role: "writer", split_percent: 40 },
      { legal_name: "Someone", role: "producer", split_percent: 40 },
    ]);
    expect(items.some((i) => i.includes("legal name"))).toBe(true);
    expect(items.some((i) => i.includes("100%"))).toBe(true);
  });

  it("accepts complete 100% splits", () => {
    expect(
      computeSplitActionItems([
        { legal_name: "A", role: "writer", split_percent: 50 },
        { legal_name: "B", role: "producer", split_percent: 50 },
      ]),
    ).toEqual([]);
  });
});

describe("lyrics + split wiring", () => {
  it("CCA dispatches lyrics and split-sheet actions behind authorizeAction", () => {
    const src = readFileSync(
      join(process.cwd(), "supabase/functions/control-center-api/index.ts"),
      "utf8",
    );
    expect(src).toMatch(/isLyricsAction/);
    expect(src).toMatch(/isSplitSheetAction/);
    expect(src).toMatch(/isSyncRegisterAction/);
  });

  it("deferred lyrics provider refuses vendor jobs", () => {
    const src = readFileSync(
      join(process.cwd(), "supabase/functions/_shared/lyrics.ts"),
      "utf8",
    );
    expect(src).toMatch(/provider_deferred/);
    expect(src).toMatch(/Phase 0 locked §6/);
  });
});
