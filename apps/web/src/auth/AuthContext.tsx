import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  hasPermission,
  type CurrentUser,
  type LoginResponse,
  type Permission,
} from "@airsoko/contracts";
import {
  apiRequest,
  loadStoredToken,
  setAccessToken,
  setUnauthorizedHandler,
} from "../api/client.ts";

interface AuthState {
  user: CurrentUser | null;
  status: "loading" | "authenticated" | "anonymous";
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => void;
  /**
   * Reads the same ROLE_PERMISSIONS table the API enforces with. The UI uses
   * it to avoid offering actions that would be refused -- never as the check
   * itself, which happens server-side on every request.
   */
  can: (permission: Permission) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  // Derived at mount rather than corrected in an effect: with no stored token
  // there is nothing to wait for, so the app should not flash a spinner.
  const [status, setStatus] = useState<AuthState["status"]>(() =>
    loadStoredToken() ? "loading" : "anonymous",
  );

  const signOut = useCallback(() => {
    setAccessToken(null);
    setUser(null);
    setStatus("anonymous");
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setUser(null);
      setStatus("anonymous");
    });
  }, []);

  // Restore a session from a stored token. The server re-reads roles on every
  // request, so a token that outlived a role change is corrected here.
  useEffect(() => {
    if (!loadStoredToken()) return;

    let cancelled = false;
    apiRequest<CurrentUser>("/api/auth/me")
      .then((current) => {
        if (cancelled) return;
        setUser(current);
        setStatus("authenticated");
      })
      .catch(() => {
        if (cancelled) return;
        setAccessToken(null);
        setStatus("anonymous");
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const response = await apiRequest<LoginResponse>("/api/auth/login", {
      method: "POST",
      body: { email, password },
    });
    setAccessToken(response.accessToken);
    setUser(response.user);
    setStatus("authenticated");
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      user,
      status,
      signIn,
      signOut,
      can: (permission) => (user ? hasPermission(user.roles, permission) : false),
    }),
    [user, status, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside an AuthProvider.");
  return context;
}
