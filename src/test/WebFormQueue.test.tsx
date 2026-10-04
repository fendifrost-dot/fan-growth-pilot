import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { WEB_FORM_EMPTY_COPY, WebFormQueue, type WebFormRow } from "@/components/hub/WebFormQueue";

vi.mock("@/lib/hubApi", () => ({
  callHubFn: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

const approved: WebFormRow = {
  id: "rec-1",
  batch_id: "batch-1",
  track_name: "Night Drive",
  playlist_name: "Late Night Rap",
  form_url: "https://playlistdock.com/playlist.php?slug=late-night",
  queue_state: "APPROVED_FOR_SEND",
  approved_by: "fendi",
  blockers: [],
};

describe("web form queue", () => {
  it("keeps approve, reject, and mark submitted visible and disabled when nothing is waiting", () => {
    render(<WebFormQueue rows={[]} onChanged={() => {}} />);
    expect(screen.getByText(WEB_FORM_EMPTY_COPY)).toBeInTheDocument();
    for (const name of ["Approve", "Reject", "Mark submitted"]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
    }
  });

  it("enables mark submitted only after an approved form is selected and the receipt is filled in", () => {
    render(<WebFormQueue rows={[approved]} onChanged={() => {}} />);
    const mark = screen.getByRole("button", { name: "Mark submitted" });
    expect(mark).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /Late Night Rap/ }));
    expect(mark).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Submission reference"), { target: { value: "confirm-9" } });
    fireEvent.change(screen.getByLabelText("Submission notes"), { target: { value: "Submitted the form by hand" } });
    expect(mark).toBeEnabled();
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
  });

  it("shows the blocker in plain language and keeps mark submitted disabled", () => {
    render(
      <WebFormQueue
        rows={[{
          ...approved,
          queue_state: "GROK_REVIEWED",
          blockers: ["This form is reviewed but not approved for sending yet."],
        }]}
        onChanged={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Late Night Rap/ }));
    expect(screen.getByText("This form is reviewed but not approved for sending yet.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mark submitted" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
  });
});
