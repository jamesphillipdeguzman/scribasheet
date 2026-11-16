import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Link, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "@/features/auth/AuthContext";
import { ForgotPasswordPage, LoginPage, RegisterPage } from "@/features/auth/AuthPages";
import { SettingsPage } from "@/features/auth/SettingsPage";
import { DashboardPage } from "@/features/dashboard/DashboardPage";
import { LandingPage } from "@/features/landing/LandingPage";
import { ProjectStudioPage } from "@/features/projects/ProjectStudioPage";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 15_000,
    },
  },
});

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth();
  if (isLoading) {
    return (
      <div className="min-h-screen bg-[#09090F] flex items-center justify-center text-sm text-[#A1A1AA]">
        Loading session...
      </div>
    );
  }
  if (!user) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}

function NotFoundPage() {
  return (
    <div className="min-h-screen bg-[#09090F] text-[#F5F3FF] flex flex-col items-center justify-center px-4 text-center space-y-4">
      <div className="text-xs font-mono uppercase tracking-widest text-[#A78BFA]">404</div>
      <h1 className="text-2xl font-bold tracking-tight">Page Not Found</h1>
      <p className="max-w-md text-sm text-[#A1A1AA]">
        The page you requested does not exist in ScribaSheet.
      </p>
      <div className="flex items-center gap-3 pt-2">
        <Link
          to="/"
          className="rounded-lg border border-[#27273A] bg-[#181825] px-4 py-2 text-sm font-medium hover:border-[#A78BFA]/50"
        >
          Go Home
        </Link>
        <Link
          to="/dashboard"
          className="rounded-lg bg-[#8B5CF6] px-4 py-2 text-sm font-medium text-[#F5F3FF] hover:bg-[#7C3AED]"
        >
          Open Dashboard
        </Link>
      </div>
    </div>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<LandingPage />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
            <Route path="/forgot-password" element={<ForgotPasswordPage />} />
            <Route
              path="/dashboard"
              element={
                <ProtectedRoute>
                  <DashboardPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/settings"
              element={
                <ProtectedRoute>
                  <SettingsPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/projects/:projectId"
              element={
                <ProtectedRoute>
                  <ProjectStudioPage />
                </ProtectedRoute>
              }
            />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
}

export default App;
