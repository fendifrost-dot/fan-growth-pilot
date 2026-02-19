import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const NEW_PIXEL_ID = "788829401662107";
const OLD_PIXEL_ID = "1125919162443596";

const html = readFileSync(resolve(__dirname, "../../index.html"), "utf-8");

describe("Meta Pixel Regression", () => {
  it("fbq init uses the new Pixel ID", () => {
    expect(html).toContain(`fbq('init', '${NEW_PIXEL_ID}')`);
  });

  it("noscript fallback uses the new Pixel ID", () => {
    expect(html).toContain(`id=${NEW_PIXEL_ID}&ev=PageView`);
  });

  it("old Pixel ID is fully removed", () => {
    expect(html).not.toContain(OLD_PIXEL_ID);
  });

  it("PageView event is still tracked", () => {
    expect(html).toContain("fbq('track', 'PageView')");
  });
});
