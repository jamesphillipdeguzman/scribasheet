import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as AuthCtx from "@/features/auth/AuthContext";
import { SettingsPage } from "@/features/auth/SettingsPage";
import { DashboardPage } from "@/features/dashboard/DashboardPage";
import { LandingPage } from "@/features/landing/LandingPage";
import { MediaUploader } from "@/features/uploads/MediaUploader";
import { api, ApiError } from "@/services/api";

const baseUser = {
  id: "u1",
  email: "musician@example.com",
  display_name: "Ada Pianist",
  email_verified: true,
  plan_tier: "free",
  is_unlimited: false,
  plan_label: "FREE",
  created_at: "",
  updated_at: "",
};

function renderWithProviders(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Uncapped Private Storage & Infrastructure Status UI", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("SettingsPage shows actual private storage used, project/file counts, and status without 250 MB or 15 project quota caps", () => {
    vi.spyOn(AuthCtx, "useAuth").mockReturnValue({
      user: baseUser,
      usage: {
        plan_tier: "free",
        plan_label: "FREE",
        is_unlimited: false,
        monthly_minutes_used: 4.5,
        monthly_minutes_limit: 30,
        project_count: 27,
        project_limit: null,
        file_count: 42,
        storage_used_bytes: 340 * 1024 * 1024,
        storage_used_mb: 340,
        storage_limit_mb: null,
        storage_quota_enforced: false,
        storage_backend: "local",
        storage_status: "available",
        storage_volume_free_mb: 8192,
        storage_volume_total_mb: 10240,
      },
      isLoading: false,
      login: vi.fn(),
      register: vi.fn(),
      logout: vi.fn(),
      refreshUser: vi.fn(),
    });

    renderWithProviders(<SettingsPage />);

    expect(screen.getByText("27")).toBeInTheDocument();
    expect(screen.getByTestId("private-storage-used")).toHaveTextContent("340.00 MB");
    expect(screen.getByText("42 stored files")).toBeInTheDocument();
    expect(screen.getByTestId("storage-health-badge")).toHaveTextContent("Available");
    expect(screen.getByTestId("storage-policy-note")).toHaveTextContent(/no application storage quota/i);

    const bodyText = document.body.textContent || "";
    expect(bodyText).not.toContain("/ 250 MB");
    expect(bodyText).not.toContain("/ 15");
    expect(bodyText).not.toMatch(/storage limit reached/i);
  });

  it("DashboardPage renders project count, storage usage, and infrastructure low-space warning without artificial quota denominator", async () => {
    vi.spyOn(AuthCtx, "useAuth").mockReturnValue({
      user: baseUser,
      usage: {
        plan_tier: "free",
        plan_label: "FREE",
        is_unlimited: false,
        monthly_minutes_used: 8,
        monthly_minutes_limit: 30,
        project_count: 19,
        project_limit: null,
        file_count: 31,
        storage_used_bytes: 512 * 1024 * 1024,
        storage_used_mb: 512,
        storage_limit_mb: null,
        storage_quota_enforced: false,
        storage_status: "low_space",
      },
      isLoading: false,
      login: vi.fn(),
      register: vi.fn(),
      logout: vi.fn(),
      refreshUser: vi.fn(),
    });

    vi.spyOn(api, "listProjects").mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      page_size: 20,
    });

    renderWithProviders(<DashboardPage />);

    await waitFor(() => {
      expect(screen.getByTestId("dashboard-storage-used")).toHaveTextContent("512.00 MB");
    });
    expect(screen.getByText("31 files")).toBeInTheDocument();
    expect(screen.getByTestId("dashboard-storage-warning")).toHaveTextContent("Low Disk Space");

    const bodyText = document.body.textContent || "";
    expect(bodyText).not.toContain("/ 250 MB");
    expect(bodyText).not.toContain("/ 15");
  });

  it("LandingPage removes the 25 GB storage quota claim", () => {
    vi.spyOn(AuthCtx, "useAuth").mockReturnValue({
      user: null,
      usage: null,
      isLoading: false,
      login: vi.fn(),
      register: vi.fn(),
      logout: vi.fn(),
      refreshUser: vi.fn(),
    });

    renderWithProviders(<LandingPage />);
    expect(screen.getByText("Uncapped private project & media storage")).toBeInTheDocument();
    expect(document.body.textContent || "").not.toContain("25 GB private media storage");
  });

  it("MediaUploader surfaces HTTP 507 infrastructure volume-full error to the user", async () => {
    vi.spyOn(api, "uploadMedia").mockRejectedValue(
      new ApiError(
        507,
        "Server storage capacity has been reached. Unable to save file because the underlying storage volume is full.",
      ),
    );

    renderWithProviders(
      <MediaUploader
        projectId="proj-1"
        existingAssets={[]}
        onUploadComplete={vi.fn()}
      />,
    );

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const wavFile = new File([new Uint8Array([82, 73, 70, 70])], "piano.wav", { type: "audio/wav" });
    fireEvent.change(fileInput, { target: { files: [wavFile] } });

    await waitFor(() => {
      expect(
        screen.getByText(/underlying storage volume is full/i),
      ).toBeInTheDocument();
    });
  });
});
