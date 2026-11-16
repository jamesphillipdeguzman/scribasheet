import React from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { LayoutDashboard, LogOut, Music, Settings, User as UserIcon } from "lucide-react";
import { BrandMark } from "@/components/BrandMark";
import { Button } from "@/components/ui/Button";
import { useAuth } from "@/features/auth/AuthContext";
import { cn } from "@/lib/utils";

export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, usage, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate("/");
  };

  const navItems = [
    { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
    { to: "/settings", label: "Account", icon: Settings },
  ];

  return (
    <div className="min-h-screen bg-[#09090F] text-[#F5F3FF] flex flex-col">
      <header className="sticky top-0 z-30 border-b border-[#27273A] bg-[#09090F]/90 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-6">
            <Link to="/dashboard" aria-label="ScribaSheet Dashboard">
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
                        ? "bg-[#181825] text-[#F5F3FF] border border-[#27273A]"
                        : "text-[#A1A1AA] hover:text-[#F5F3FF] hover:bg-[#11111B]"
                    )}
                  >
                    <Icon className="h-4 w-4 text-[#A78BFA]" />
                    {item.label}
                  </Link>
                );
              })}
            </nav>
          </div>

          <div className="flex items-center gap-3">
            {usage && (
              <div className="hidden md:flex items-center gap-2 rounded-lg border border-[#27273A] bg-[#11111B] px-3 py-1 text-xs text-[#A1A1AA]">
                <Music className="h-3.5 w-3.5 text-[#A78BFA]" />
                <span>
                  {usage.monthly_minutes_used} / {usage.monthly_minutes_limit} min
                </span>
                <span className="rounded bg-[#181825] px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-[#A78BFA]">
                  {usage.plan_tier}
                </span>
              </div>
            )}
            <div className="hidden sm:flex items-center gap-2 text-xs text-[#A1A1AA]">
              <UserIcon className="h-3.5 w-3.5" />
              <span className="max-w-[140px] truncate">{user?.display_name || user?.email}</span>
            </div>
            <Button variant="ghost" size="sm" onClick={handleLogout} aria-label="Sign out">
              <LogOut className="h-4 w-4" />
              <span className="hidden sm:inline">Sign Out</span>
            </Button>
          </div>
        </div>
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}
