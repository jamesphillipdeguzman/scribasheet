import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api, ApiError, clearStoredTokens, getStoredTokens, setStoredTokens } from "@/services/api";
import type { UsageSummary, User } from "@/types/api";

interface AuthContextValue {
  user: User | null;
  usage: UsageSummary | null;
  isLoading: boolean;
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
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        clearStoredTokens();
        setUser(null);
        setUsage(null);
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
    setUser(res.user);
    const u = await api.getUsage();
    setUsage(u);
  };

  const register = async (email: string, password: string, displayName: string) => {
    const res = await api.register({ email, password, display_name: displayName });
    setStoredTokens(res.access_token, res.refresh_token);
    setUser(res.user);
    const u = await api.getUsage();
    setUsage(u);
  };

  const logout = () => {
    clearStoredTokens();
    setUser(null);
    setUsage(null);
  };

  return (
    <AuthContext.Provider value={{ user, usage, isLoading, login, register, logout, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
