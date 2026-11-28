import React, { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { LayoutDashboard, ListMusic, LogOut, Menu, Music, Settings, User as UserIcon, X } from "lucide-react";
import { BrandMark } from "@/components/BrandMark";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Button } from "@/components/ui/Button";
import { useAuth } from "@/features/auth/AuthContext";
import { cn } from "@/lib/utils";

export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, usage, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const handleLogout = () => {
    setMobileMenuOpen(false);
    logout();
    navigate("/");
  };

  const navItems = [
    { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
    { to: "/playlists", label: "Playlists", icon: ListMusic },
    { to: "/settings", label: "Account", icon: Settings },
  ];

  return (
    <div className="min-h-screen w-full max-w-full bg-[#09090F] text-[#F5F3FF] flex flex-col">
      <header className="sticky top-0 z-30 border-b border-[#27273A] bg-[#09090F]/90 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between gap-2 px-3 sm:px-6 min-w-0">
          <div className="flex items-center gap-3 sm:gap-6 min-w-0">
            <Link to="/dashboard" aria-label="ScribaSheet Dashboard" className="shrink-0">
              <BrandMark size="sm" />
            </Link>
            <nav className="hidden sm:flex items-center gap-1" aria-label="Main navigation">
              {navItems.map((item) => {
                const Icon = item.icon;
                const active = location.pathname.startsWith(item.to);
                return (
                  <Link
                    key={item.to}
                    to={item.to}
                    className={cn(
                      "inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
                      active
                        ? "bg-stone-200/90 text-stone-950 font-semibold border border-stone-300/80 dark:bg-white/10 dark:text-white dark:border-[#27273A]"
                        : "text-stone-600 hover:bg-stone-200/75 hover:text-stone-950 dark:text-[#A1A1AA] dark:hover:bg-white/10 dark:hover:text-white"
                    )}
                  >
                    <Icon className="h-4 w-4 text-[#A78BFA]" />
                    {item.label}
                  </Link>
                );
              })}
            </nav>
          </div>

          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
            <ThemeToggle />
            {usage && (() => {
              const isUnlimited = Boolean(usage.is_unlimited || user?.is_unlimited);
              const planLabel = usage.plan_label || (isUnlimited ? "UNLIMITED" : usage.plan_tier);
              return (
                <div
                  data-testid="navbar-usage-indicator"
                  className="hidden md:flex items-center gap-2 rounded-lg border border-[#27273A] bg-[#11111B] px-3 py-1 text-xs text-[#A1A1AA]"
                >
                  <Music className="h-3.5 w-3.5 text-[#A78BFA]" />
                  <span>
                    {isUnlimited
                      ? `${usage.monthly_minutes_used} min used`
                      : `${usage.monthly_minutes_used} / ${usage.monthly_minutes_limit} min`}
                  </span>
                  <span className="rounded bg-[#181825] px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-[#A78BFA]">
                    {planLabel}
                  </span>
                </div>
              );
            })()}
            <div className="hidden sm:flex items-center gap-2 text-xs text-[#A1A1AA]">
              <UserIcon className="h-3.5 w-3.5" />
              <span className="max-w-[140px] truncate">{user?.display_name || user?.email}</span>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleLogout}
              aria-label="Sign out"
              className="hidden sm:inline-flex min-h-[36px]"
            >
              <LogOut className="h-4 w-4" />
              <span>Sign Out</span>
            </Button>
            <button
              type="button"
              onClick={() => setMobileMenuOpen((v) => !v)}
              aria-label={mobileMenuOpen ? "Close navigation menu" : "Open navigation menu"}
              aria-expanded={mobileMenuOpen}
              className="sm:hidden inline-flex h-11 w-11 items-center justify-center rounded-lg border border-stone-300 bg-white text-stone-700 hover:bg-stone-200/80 hover:text-stone-950 transition-colors dark:border-[#27273A] dark:bg-[#11111B] dark:text-[#F5F3FF] dark:hover:bg-white/10"
            >
              {mobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
          </div>
        </div>

        {mobileMenuOpen && (
          <div className="sm:hidden border-t border-[#27273A] bg-[#11111B] px-3 py-3 space-y-2">
            <div className="flex items-center justify-between gap-2 rounded-lg bg-[#09090F] px-3 py-2 text-xs text-[#A1A1AA]">
              <span className="truncate">{user?.display_name || user?.email || "Account"}</span>
              {usage && (
                <span className="shrink-0 text-[#A78BFA]">
                  {usage.monthly_minutes_used}/{usage.monthly_minutes_limit}m
                </span>
              )}
            </div>
            <nav className="flex flex-col gap-1" aria-label="Mobile navigation">
              {navItems.map((item) => {
                const Icon = item.icon;
                const active = location.pathname.startsWith(item.to);
                return (
                  <Link
                    key={item.to}
                    to={item.to}
                    onClick={() => setMobileMenuOpen(false)}
                    className={cn(
                      "flex min-h-[44px] items-center gap-2.5 rounded-lg px-3 text-sm font-medium transition-colors",
                      active
                        ? "bg-stone-200/90 text-stone-950 font-semibold border border-stone-300/80 dark:bg-white/10 dark:text-white dark:border-[#27273A]"
                        : "text-stone-600 hover:bg-stone-200/75 hover:text-stone-950 dark:text-[#A1A1AA] dark:hover:bg-white/10 dark:hover:text-white"
                    )}
                  >
                    <Icon className="h-4 w-4 text-[#A78BFA]" />
                    {item.label}
                  </Link>
                );
              })}
              <button
                type="button"
                onClick={handleLogout}
                className="flex min-h-[44px] items-center gap-2.5 rounded-lg px-3 text-sm font-medium text-red-700 hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-500/10 text-left transition-colors"
              >
                <LogOut className="h-4 w-4" />
                Sign Out
              </button>
            </nav>
          </div>
        )}
      </header>
      <main className="flex-1 min-w-0">{children}</main>
      <footer className="border-t border-stone-200 dark:border-white/10 py-4 mt-8">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-stone-600 dark:text-slate-400">
          <span>ScribaSheet — AI-Powered Music Transcription Studio.</span>
          <span className="text-stone-600 dark:text-slate-500">
            © {new Date().getFullYear()} James Phillip De Guzman. All rights reserved.
          </span>
        </div>
      </footer>
    </div>
  );
}
