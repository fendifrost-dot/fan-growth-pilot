import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const callHubFn = vi.fn();

vi.mock("@/lib/hubApi", () => ({
  callHubFn: (...args: unknown[]) => callHubFn(...args),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import AdminLicensing from "@/pages/admin/AdminLicensing";

const trackRow = {
  id: "track-generic",
  name: "Runway Music",
  is_month1_sync_default: false,
};

const approvedDraft = {
  id: "draft-1",
  track_id: "track-generic",
  subject: "Fixture licensing subject",
  status: "approved",
  approved_by: "grok_playlist_control",
  approved_by_label: "grok_playlist_control",
};

describe("AdminLicensing Hub Resend execute", () => {
  beforeEach(() => {
    callHubFn.mockReset();
    callHubFn.mockImplementation(async (action: string, body?: Record<string, unknown>) => {
      if (action === "list_music_supervisors") return { rows: [] };
      if (action === "list_tracks") return { rows: [trackRow] };
      if (action === "list_licensing_pitches") return { rows: [] };
      if (action === "list_sync_pending_drafts") return { drafts: [approvedDraft] };
      if (action === "execute_sync_pitch") {
        return {
          ok: true,
          dry_run: Boolean(body?.dry_run),
          submitted: false,
          would_send: true,
          from_address: "Fendi Frost <pitches@fendifrost.com>",
          to: "supervisor@example.com",
          subject: "Fixture licensing subject",
        };
      }
      return { ok: true };
    });
  });

  it("lists approved drafts and dry-runs execute_sync_pitch without sending", async () => {
    render(
      <MemoryRouter>
        <AdminLicensing />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("sync-hub-execute")).toBeInTheDocument();
    });
    expect(screen.getByText("Fixture licensing subject")).toBeInTheDocument();
    expect(screen.getByText("Runway Music")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Dry-run" }));

    await waitFor(() => {
      expect(callHubFn).toHaveBeenCalledWith("execute_sync_pitch", expect.objectContaining({
        draft_id: "draft-1",
        dry_run: true,
        test_mode: false,
        submission_channel: "email",
      }));
    });

    await waitFor(() => {
      expect(screen.getByTestId("sync-hub-dry-run-preview")).toHaveTextContent("pitches@fendifrost.com");
    });
    expect(callHubFn.mock.calls.some(([action]) => action === "execute_sync_pitch" &&
      (callHubFn.mock.calls.find(([a]) => a === "execute_sync_pitch")?.[1] as { dry_run?: boolean })?.dry_run === false,
    )).toBe(false);
  });
});
