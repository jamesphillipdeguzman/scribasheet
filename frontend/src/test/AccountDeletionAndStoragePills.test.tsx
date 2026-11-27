import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as AuthCtx from "@/features/auth/AuthContext";
import { DeleteAccountModal } from "@/features/auth/DeleteAccountModal";
import { SettingsPage } from "@/features/auth/SettingsPage";
import { DashboardPage } from "@/features/dashboard/DashboardPage";
import { api, ApiError } from "@/services/api";

const baseUser = {
  id: "u-acc-1",
  email: "musician@example.com",
  display_name: "Ada Pianist",
  email_verified: true,
  plan_tier: "free",
  is_unlimited: false,
  plan_label: "FREE",
  created_at: "",
  updated_at: "",
};

function renderWithRouter(ui: React.ReactElement, initialPath = "/settings") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/settings" element={ui} />
          <Route path="/dashboard" element={ui} />
          <Route path="/" element={<div data-testid="landing-redirect">Landing Home</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const EXPECTED_PILL_LAYOUT_CLASSES = [
  "whitespace-nowrap",
  "shrink-0",
  "inline-flex",
  "items-center",
  "px-2.5",
  "py-0.5",
  "rounded-full",
  "text-xs",
  "font-semibold",
];

const EXPECTED_AMBER_THEME_CLASSES = [
  "bg-amber-100",
  "text-amber-900",
  "border",
  "border-amber-300",
  "dark:bg-amber-500/15",
  "dark:text-amber-300",
  "dark:border-amber-500/30",
];

describe("Light-Mode Storage Warning Pills & DeleteAccountModal", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders high-contrast, single-line warning pills in DashboardPage and SettingsPage", async () => {
    const logoutSpy = vi.fn();
    vi.spyOn(AuthCtx, "useAuth").mockReturnValue({
      user: baseUser,
      usage: {
        plan_tier: "free",
        plan_label: "FREE",
        is_unlimited: false,
        monthly_minutes_used: 8,
        monthly_minutes_limit: 30,
        project_count: 12,
        project_limit: null,
        file_count: 18,
        storage_used_bytes: 512 * 1024 * 1024,
        storage_used_mb: 512,
        storage_limit_mb: null,
        storage_quota_enforced: false,
        storage_status: "low_space",
      },
      isLoading: false,
      login: vi.fn(),
      register: vi.fn(),
      logout: logoutSpy,
      refreshUser: vi.fn(),
    });
    vi.spyOn(api, "listProjects").mockResolvedValue({ items: [], total: 0, page: 1, page_size: 20 });

    const { unmount } = renderWithRouter(<DashboardPage />, "/dashboard");
    await waitFor(() => expect(screen.getByTestId("dashboard-storage-warning")).toBeInTheDocument());
    const dashPill = screen.getByTestId("dashboard-storage-warning");
    expect(dashPill).toHaveTextContent("Low Disk Space");
    for (const cls of [...EXPECTED_PILL_LAYOUT_CLASSES, ...EXPECTED_AMBER_THEME_CLASSES]) {
      expect(dashPill).toHaveClass(cls);
    }
    expect(screen.getByTestId("dashboard-storage-used")).toHaveTextContent("512.00 MB");
    unmount();

    renderWithRouter(<SettingsPage />, "/settings");
    const settingsPill = screen.getByTestId("storage-health-badge");
    expect(settingsPill).toHaveTextContent("Low Server Space");
    expect(screen.getByText("Private Storage Used")).toBeInTheDocument();
    expect(screen.getByTestId("private-storage-used")).toHaveTextContent("512.00 MB");
    for (const cls of [...EXPECTED_PILL_LAYOUT_CLASSES, ...EXPECTED_AMBER_THEME_CLASSES]) {
      expect(settingsPill).toHaveClass(cls);
    }
  });

  it("opens DeleteAccountModal without API calls, validates two-step confirmation, prevents duplicates, and handles errors/success", async () => {
    const logoutSpy = vi.fn();
    let resolveDelete: (() => void) | null = null;
    const deleteMeSpy = vi
      .spyOn(api, "deleteMe")
      .mockRejectedValueOnce(new ApiError(500, "Temporary server error while purging files."))
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveDelete = resolve;
          }),
      );

    vi.spyOn(AuthCtx, "useAuth").mockReturnValue({
      user: baseUser,
      usage: null,
      isLoading: false,
      login: vi.fn(),
      register: vi.fn(),
      logout: logoutSpy,
      refreshUser: vi.fn(),
    });

    renderWithRouter(<SettingsPage />, "/settings");

    const triggerBtn = screen.getByRole("button", { name: /delete account/i });
    fireEvent.click(triggerBtn);

    // No API call on open; modal shows complete warning & 4 data types
    expect(deleteMeSpy).not.toHaveBeenCalled();
    const modal = screen.getByRole("dialog");
    expect(modal).toHaveAttribute("aria-modal", "true");
    expect(within(modal).getByText("All projects")).toBeInTheDocument();
    expect(within(modal).getByText("Sheet music scores")).toBeInTheDocument();
    expect(within(modal).getByText("Uploaded audio recordings")).toBeInTheDocument();
    expect(within(modal).getByText("Exported files")).toBeInTheDocument();

    // Focus moves into modal on open and returns to trigger button on Escape/Cancel
    await waitFor(() => expect(modal.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(document.activeElement).toBe(triggerBtn);

    // Re-open and test strict two-step validation
    fireEvent.click(triggerBtn);
    const openModal = screen.getByRole("dialog");
    const checkbox = within(openModal).getByLabelText("I understand this action is permanent and cannot be undone.") as HTMLInputElement;
    const confirmInput = within(openModal).getByRole("textbox") as HTMLInputElement;
    const permanentBtn = within(openModal).getByTestId("confirm-permanent-delete-btn") as HTMLButtonElement;

    expect(permanentBtn).toBeDisabled();

    // Email typed without checkbox -> stays disabled
    fireEvent.change(confirmInput, { target: { value: "musician@example.com" } });
    expect(permanentBtn).toBeDisabled();

    // Checkbox checked with partial or differently cased email -> stays disabled
    fireEvent.click(checkbox);
    fireEvent.change(confirmInput, { target: { value: "Musician@example.com" } });
    expect(permanentBtn).toBeDisabled();
    fireEvent.change(confirmInput, { target: { value: "musician@example" } });
    expect(permanentBtn).toBeDisabled();

    // Exact match enables button
    fireEvent.change(confirmInput, { target: { value: "musician@example.com" } });
    expect(permanentBtn).toBeEnabled();

    // First attempt fails -> modal stays open, error shown, logout NOT called
    fireEvent.click(permanentBtn);
    await waitFor(() =>
      expect(within(openModal).getByRole("alert")).toHaveTextContent("Temporary server error while purging files."),
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(logoutSpy).not.toHaveBeenCalled();

    // Second attempt: in-flight double clicks do not duplicate calls & Escape is locked
    fireEvent.click(permanentBtn);
    const form = openModal.querySelector("form")!;
    fireEvent.submit(form);
    fireEvent.click(permanentBtn);

    expect(deleteMeSpy).toHaveBeenCalledTimes(2);
    expect(permanentBtn).toHaveTextContent("Deleting Account...");
    expect(checkbox).toBeDisabled();
    expect(confirmInput).toBeDisabled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    // Resolve deletion -> closes modal, calls logout(), and navigates home
    await act(async () => {
      resolveDelete?.();
    });
    await waitFor(() => expect(logoutSpy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId("landing-redirect")).toBeInTheDocument());
  });

  it("requires exact word DELETE when authenticated account email is unavailable", async () => {
    const confirmSpy = vi.fn().mockResolvedValue(undefined);
    render(
      <DeleteAccountModal
        isOpen={true}
        userEmail=""
        onClose={vi.fn()}
        onConfirmDelete={confirmSpy}
      />,
    );

    const modal = screen.getByRole("dialog");
    const checkbox = within(modal).getByLabelText("I understand this action is permanent and cannot be undone.");
    const input = within(modal).getByRole("textbox");
    const submitBtn = within(modal).getByTestId("confirm-permanent-delete-btn");

    fireEvent.click(checkbox);
    fireEvent.change(input, { target: { value: "delete" } });
    expect(submitBtn).toBeDisabled();

    fireEvent.change(input, { target: { value: "DELETE" } });
    expect(submitBtn).toBeEnabled();

    fireEvent.click(submitBtn);
    await waitFor(() => expect(confirmSpy).toHaveBeenCalledTimes(1));
  });
});
