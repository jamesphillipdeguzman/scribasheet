import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import {
  api,
  ApiError,
  clearStoredTokens,
  getStoredTokens,
  onAuthSessionExpired,
  setStoredTokens,
} from "@/services/api";
import type { UsageSummary, User } from "@/types/api";

interface AuthContextValue {
  user: User | null;
  usage: UsageSummary | null;
  isLoading: boolean;
  sessionExpired?: boolean;
  sessionExpiredMessage?: string | null;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, displayName: string) => Promise<void>;
  logout: () => void;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [sessionExpiredMessage, setSessionExpiredMessage] = useState<string | null>(null);

  useEffect(() => {
    return onAuthSessionExpired((msg) => {
      setSessionExpired(true);
      setSessionExpiredMessage(msg);
    });
  }, []);

  const refreshUser = useCallback(async () => {
    const { accessToken } = getStoredTokens();
    if (!accessToken) {
      setUser(null);
      setUsage(null);
      setIsLoading(false);
      return;
    }
    try {
      const [me, u] = await Promise.all([api.getMe(), api.getUsage()]);
      setUser(me);
      setUsage(u);
      setSessionExpired(false);
      setSessionExpiredMessage(null);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        clearStoredTokens();
        setUser(null);
        setUsage(null);
        setSessionExpired(true);
        setSessionExpiredMessage(err.message);
      }
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshUser();
  }, [refreshUser]);

  const login = async (email: string, password: string) => {
    const res = await api.login({ email, password });
    setStoredTokens(res.access_token, res.refresh_token);
    setSessionExpired(false);
    setSessionExpiredMessage(null);
    setUser(res.user);
    try {
      const u = await api.getUsage();
      setUsage(u);
    } catch {
      // Non-fatal: usage summary can refresh later on dashboard
    }
  };

  const register = async (email: string, password: string, displayName: string) => {
    const res = await api.register({ email, password, display_name: displayName });
    setStoredTokens(res.access_token, res.refresh_token);
    setSessionExpired(false);
    setSessionExpiredMessage(null);
    setUser(res.user);
    const u = await api.getUsage();
    setUsage(u);
  };

  const logout = () => {
    clearStoredTokens();
    setSessionExpired(false);
    setSessionExpiredMessage(null);
    setUser(null);
    setUsage(null);
  };

  useEffect(() => {
    const onRefreshUsage = () => {
      void refreshUser();
    };
    window.addEventListener("scribasheet:refresh-usage", onRefreshUsage);
    return () => window.removeEventListener("scribasheet:refresh-usage", onRefreshUsage);
  }, [refreshUser]);

  return (
    <AuthContext.Provider
      value={{
        user,
        usage,
        isLoading,
        sessionExpired,
        sessionExpiredMessage,
        login,
        register,
        logout,
        refreshUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}

export function useOptionalAuth() {
  return useContext(AuthContext);
}
