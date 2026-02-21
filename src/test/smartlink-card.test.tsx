import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { SmartLinkCard } from "@/components/SmartLinkCard";

vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));

describe("SmartLinkCard: canonical URL and per-link images", () => {
  it("displays only canonical links.fendifrost.com URL for HeartChakra", () => {
    const { container } = render(
      <SmartLinkCard
        title="Heart Chakra"
        url="https://even.biz/heartchakra"
        slug="HeartChakra"
        clicks={42}
        ctaClicks={10}
        conversions={5}
        ogImageUrl="https://links.fendifrost.com/og-chakra.png"
      />
    );

    const urlEl = container.querySelector('[data-testid="canonical-url"]')!;
    expect(urlEl.textContent).toContain("https://links.fendifrost.com/HeartChakra");
    expect(urlEl.textContent).not.toContain("lovable.app");
    expect(urlEl.textContent).not.toContain("even.biz");
  });

  it("renders different thumbnails for two links with different og_image_url", () => {
    const { container: c1 } = render(
      <SmartLinkCard title="Runway Music" url="https://even.biz/runway" slug="runwaymusic" clicks={100} ctaClicks={20} conversions={10} ogImageUrl="https://links.fendifrost.com/og-runwaymusic.png" />
    );
    const { container: c2 } = render(
      <SmartLinkCard title="Heart Chakra" url="https://even.biz/heartchakra" slug="HeartChakra" clicks={42} ctaClicks={8} conversions={5} ogImageUrl="https://links.fendifrost.com/og-chakra.png" />
    );

    const img1 = c1.querySelector("img")!;
    const img2 = c2.querySelector("img")!;
    expect(img1.src).toContain("og-runwaymusic.png");
    expect(img2.src).toContain("og-chakra.png");
    expect(img1.src).not.toEqual(img2.src);
  });

  it("uses default fallback image when ogImageUrl is null", () => {
    const { container } = render(
      <SmartLinkCard title="No Image Link" url="https://example.com" slug="test" clicks={0} ctaClicks={0} conversions={0} ogImageUrl={null} />
    );
    const img = container.querySelector("img")!;
    expect(img.src).toContain("og-runwaymusic.png");
  });

  it("does not display short link section", () => {
    const { container } = render(
      <SmartLinkCard title="Test" url="https://example.com" slug="test" shortCode="abc123" clicks={0} ctaClicks={0} conversions={0} />
    );
    expect(container.textContent).not.toContain("Copy Short Link");
  });
});
