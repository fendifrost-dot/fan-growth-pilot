import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const hub = vi.fn();

vi.mock("@/lib/hubApi", () => ({
  callHubFn: (...args: unknown[]) => hub(...args),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const tracks = [
  {
    id: "t-med",
    name: "Meditate",
    isrc: "US-SECRET-0000000",
    status: "active",
    default_tone: "warm_personal",
    reference_artists: [],
    updated_at: "2026-08-31T00:00:00Z",
    aggregator: "open",
    genre_stamp: "hip_hop_rap",
    has_sample: "no",
    sync_eligible: true,
    is_month1_sync_default: true,
    track_categories: [],
  },
  {
    id: "t-prada",
    name: "Neva Too Much Prada",
    isrc: null,
    status: "active",
    default_tone: "warm_personal",
    reference_artists: [],
    updated_at: "2026-08-31T00:00:00Z",
    aggregator: "open",
    genre_stamp: "unknown",
    has_sample: "yes",
    sync_eligible: false,
    is_month1_sync_default: false,
    track_categories: [],
  },
];

describe("operator song + licensing registers", () => {
  beforeEach(() => {
    hub.mockReset();
    hub.mockImplementation(async (action: string) => {
      if (action === "list_tracks") return { rows: tracks };
      if (action === "list_categories") return { rows: [] };
      if (action === "list_music_supervisors") return { rows: [] };
      if (action === "list_licensing_pitches") return { rows: [] };
      return { rows: [] };
    });
  });

  it("renders the song register with Meditate as Hip-Hop/Rap, no sample, no raw ISRC in the table", async () => {
    const { default: AdminCatalogue } = await import("@/pages/admin/AdminCatalogue");
    const { container } = render(
      <MemoryRouter>
        <AdminCatalogue />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(container.querySelector('[data-testid="song-register"]')).toBeTruthy();
      expect(container.textContent).toContain("Meditate");
      expect(container.textContent).toContain("Hip-Hop/Rap");
      expect(container.textContent).toContain("No sample");
      expect(container.textContent).toContain("Month-one candidate");
      expect(container.textContent).toContain("Neva Too Much Prada");
    });
    expect(container.textContent).not.toContain("US-SECRET-0000000");
    expect(container.textContent).toMatch(/on file/);
  });

  it("renders an empty licensing log and supervisor roster", async () => {
    const { default: AdminLicensing } = await import("@/pages/admin/AdminLicensing");
    const { container } = render(
      <MemoryRouter>
        <AdminLicensing />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(container.querySelector('[data-testid="licensing-register"]')).toBeTruthy();
      expect(container.textContent).toContain("Licensing register");
      expect(container.textContent).toContain("No licensing pitches yet");
      expect(container.textContent).toContain("Roster is empty");
      expect(container.querySelector('[data-testid="month1-candidate-notice"]')).toBeTruthy();
      expect(container.textContent).toContain("Month-one candidate — not approved for sync submission");
      expect(container.textContent).toContain("Select song — no default");
    });
    // Must not auto-select Meditate into a live log/send control.
    const songTrigger = container.querySelector('[data-testid="licensing-song-select"]');
    expect(songTrigger?.textContent ?? "").not.toMatch(/^Meditate/);
    expect(container.textContent).not.toContain("US-SECRET");
  });

  it("labels Meditate as month-one candidate in the song register, not as sync-approved", async () => {
    const { default: AdminCatalogue } = await import("@/pages/admin/AdminCatalogue");
    const { container } = render(
      <MemoryRouter>
        <AdminCatalogue />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(container.textContent).toContain("Month-one candidate");
    });
    expect(container.textContent).not.toContain("Month-1 sync");
  });
});
