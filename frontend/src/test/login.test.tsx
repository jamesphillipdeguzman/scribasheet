import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { AuthProvider } from "@/features/auth/AuthContext";
import { LoginPage } from "@/features/auth/AuthPages";

describe("LoginPage & AuthProvider cold-start / cancellation regression", () => {
  it("completes LoginPage flow in StrictMode even when health warm-up fails, and recovers after 401", async () => {
    const store = new Map<string, string>();
    const memoryStorage: Storage = {
      get length() {
        return store.size;
      },
      clear: () => store.clear(),
      getItem: (k: string) => store.get(k) ?? null,
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      removeItem: (k: string) => {
        store.delete(k);
      },
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
    };
    vi.stubGlobal("localStorage", memoryStorage);

    let loginAttempt = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/health")) {
        return new Response("Gateway Timeout", { status: 504 });
      }
      if (url.endsWith("/auth/login")) {
        loginAttempt += 1;
        if (loginAttempt === 1) {
          return new Response(JSON.stringify({ detail: "Invalid email or password." }), { status: 401 });
        }
        return new Response(
          JSON.stringify({
            access_token: "jwt-access-123",
            refresh_token: "jwt-refresh-456",
            token_type: "bearer",
            user: {
              id: "u1",
              email: "user@example.com",
              display_name: "Tester",
              email_verified: true,
              plan_tier: "free",
              created_at: "",
              updated_at: "",
            },
          }),
          { status: 200 }
        );
      }
      if (url.endsWith("/users/me/usage")) {
        return new Response(
          JSON.stringify({
            plan_tier: "free",
            monthly_minutes_used: 0,
            monthly_minutes_limit: 30,
            project_count: 0,
            project_limit: 3,
            storage_used_mb: 0,
            storage_limit_mb: 100,
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      render(
        <React.StrictMode>
          <AuthProvider>
            <MemoryRouter initialEntries={["/login"]}>
              <Routes>
                <Route path="/login" element={<LoginPage />} />
                <Route path="/dashboard" element={<div>Dashboard Reached</div>} />
              </Routes>
            </MemoryRouter>
          </AuthProvider>
        </React.StrictMode>
      );

      fireEvent.change(screen.getByPlaceholderText("you@example.com"), { target: { value: "user@example.com" } });
      fireEvent.change(screen.getByPlaceholderText("••••••••"), { target: { value: "wrongpass" } });
      fireEvent.click(screen.getByRole("button", { name: /Sign In/i }));

      await waitFor(() => {
        expect(screen.getByRole("alert")).toHaveTextContent("Invalid email or password.");
      });
      expect(loginAttempt).toBe(1);

      // Re-submit with valid password succeeds and redirects
      fireEvent.change(screen.getByPlaceholderText("••••••••"), { target: { value: "correctpass" } });
      fireEvent.click(screen.getByRole("button", { name: /Sign In/i }));

      await waitFor(() => {
        expect(screen.getByText("Dashboard Reached")).toBeInTheDocument();
      });
      expect(store.get("scribasheet_access_token")).toBe("jwt-access-123");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
