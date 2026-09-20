import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import ArtistLayout from "@/components/hub/ArtistLayout";
import { HUB_NAV, HUB_NAV_ITEMS } from "@/components/hub/hubNav";

describe("hub navigation config", () => {
  it("includes every required artist-ops section", () => {
    const labels = HUB_NAV_ITEMS.map((i) => i.label);
    for (const required of [
      "Dashboard",
      "Smart Links",
      "Spotify",
      "Apple Music",
      "YouTube",
      "Social",
      "Playlist",
      "Sync",
    ]) {
      expect(labels).toContain(required);
    }
  });

  it("has unique, hub-scoped routes", () => {
    const routes = HUB_NAV_ITEMS.map((i) => i.to);
    expect(new Set(routes).size).toBe(routes.length);
    for (const to of routes) {
      expect(to.startsWith("/hub")).toBe(true);
    }
  });

  it("marks only the dashboard index route as end-matched", () => {
    const dashboard = HUB_NAV_ITEMS.find((i) => i.label === "Dashboard");
    expect(dashboard?.to).toBe("/hub");
    expect(dashboard?.end).toBe(true);
  });
});

describe("ArtistLayout shell", () => {
  const renderShell = () =>
    render(
      <MemoryRouter initialEntries={["/hub"]}>
        <Routes>
          <Route path="/hub" element={<ArtistLayout />}>
            <Route index element={<div>dashboard content</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

  it("renders a hamburger menu trigger for mobile", () => {
    renderShell();
    expect(screen.getByLabelText("Open menu")).toBeInTheDocument();
  });

  it("renders every section link in the sidebar", () => {
    renderShell();
    // Each section label appears in the persistent desktop sidebar.
    for (const item of HUB_NAV_ITEMS) {
      expect(screen.getAllByText(item.label).length).toBeGreaterThan(0);
    }
  });

  it("renders the routed outlet content", () => {
    renderShell();
    expect(screen.getByText("dashboard content")).toBeInTheDocument();
  });

  it("links to the operator tools", () => {
    renderShell();
    expect(screen.getByText("Operator tools")).toBeInTheDocument();
  });
});
