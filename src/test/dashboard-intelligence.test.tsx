import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";

// Mock supabase
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "test-user" } } }) },
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          order: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue({ data: [], error: null }),
          }),
          in: vi.fn().mockResolvedValue({ data: [], error: null }),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        }),
        in: vi.fn().mockResolvedValue({ data: [], error: null }),
        order: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue({ data: [], error: null }),
        }),
      }),
    }),
    functions: {
      invoke: vi.fn().mockResolvedValue({ data: {}, error: null }),
    },
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  },
}));

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <BrowserRouter>{children}</BrowserRouter>
    </QueryClientProvider>
  );
};

describe("Dashboard Regression", () => {
  it("renders the main dashboard without crashing", async () => {
    const Index = (await import("@/pages/Index")).default;
    render(<Index />, { wrapper });
    expect(screen.getByText("Performance Overview")).toBeInTheDocument();
    expect(screen.getByText("Smart Links")).toBeInTheDocument();
  });

  it("renders Fan Intelligence section", async () => {
    const Index = (await import("@/pages/Index")).default;
    render(<Index />, { wrapper });
    expect(screen.getByText("Fan Intelligence")).toBeInTheDocument();
    expect(screen.getByText("Fan Database")).toBeInTheDocument();
  });

  it("renders the existing metric cards section", async () => {
    const Index = (await import("@/pages/Index")).default;
    render(<Index />, { wrapper });
    expect(screen.getByText("Performance Overview")).toBeInTheDocument();
  });

  it("renders the quick actions CTA", async () => {
    const Index = (await import("@/pages/Index")).default;
    render(<Index />, { wrapper });
    expect(screen.getByText("Ready to grow your fanbase?")).toBeInTheDocument();
  });
});

describe("New Component Rendering", () => {
  it("FanDatabaseOverview renders without crashing", async () => {
    const { FanDatabaseOverview } = await import("@/components/FanDatabaseOverview");
    render(<FanDatabaseOverview />, { wrapper });
    // Should show tier cards in loading or loaded state
    expect(document.querySelector('[class*="card"]')).toBeTruthy();
  });

  it("MomentumAlerts renders without crashing", async () => {
    const { MomentumAlerts } = await import("@/components/MomentumAlerts");
    render(<MomentumAlerts />, { wrapper });
    expect(document.querySelector('[class*="card"]')).toBeTruthy();
  });

  it("MarketingRecommendations renders without crashing", async () => {
    const { MarketingRecommendations } = await import("@/components/MarketingRecommendations");
    render(<MarketingRecommendations />, { wrapper });
    expect(document.querySelector('[class*="card"]')).toBeTruthy();
  });

  it("IntelligenceControl renders without crashing", async () => {
    const { IntelligenceControl } = await import("@/components/IntelligenceControl");
    render(<IntelligenceControl />, { wrapper });
    expect(screen.getByText("Fan Intelligence Engine")).toBeInTheDocument();
  });
});
