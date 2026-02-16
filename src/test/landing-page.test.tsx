import { describe, it, expect, vi } from "vitest";
import { render, act } from "@testing-library/react";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }), onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })) },
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        or: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: "test-id",
                title: "Test Album",
                slug: "test-album",
                destination_url: "https://even.biz/test",
                headline: "Test Headline",
                subheadline: "Test sub",
                button_text: "Go to Album",
                show_email_form: true,
                theme_preset: "default",
                user_id: "user-1",
                is_active: true,
              },
              error: null,
            }),
          })),
        })),
      })),
    })),
    rpc: vi.fn(),
    storage: { from: vi.fn(() => ({ createSignedUrl: vi.fn() })) },
  },
}));

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return {
    ...actual,
    useParams: () => ({ slug: "test-album" }),
    Navigate: () => null,
  };
});

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

describe("Landing page conversion flow", () => {
  it("renders a direct album CTA button without requiring email", async () => {
    const SmartLinkPage = (await import("@/pages/SmartLinkPage")).default;
    let container: HTMLElement;
    
    await act(async () => {
      const result = render(<SmartLinkPage />);
      container = result.container;
      await wait(100); // allow useEffect to resolve
    });

    const albumBtn = container!.querySelector('[data-testid="album-cta"]');
    expect(albumBtn).toBeTruthy();
    expect(albumBtn!.textContent).toContain("Go to Album");
  });

  it("email plaque is collapsed by default (trigger visible, form hidden)", async () => {
    const SmartLinkPage = (await import("@/pages/SmartLinkPage")).default;
    let container: HTMLElement;
    
    await act(async () => {
      const result = render(<SmartLinkPage />);
      container = result.container;
      await wait(100);
    });

    const trigger = container!.querySelector('[data-testid="email-plaque-trigger"]');
    expect(trigger).toBeTruthy();
    expect(trigger!.textContent).toContain("Unlock extras");

    // The email form should NOT be visible initially (collapsed)
    const form = container!.querySelector('[data-testid="email-form"]');
    expect(form).toBeNull();
  });
});
