import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import * as api from "../lib/adminApi";

interface AdminAuthState {
  token: string | null;
  isAuthenticated: boolean;
  isSetUp: boolean | null;
  mfaEnabled: boolean;
  loading: boolean;
}

interface AdminAuthActions {
  checkSetupStatus: () => Promise<void>;
  setupAdmin: (username: string, password: string) => Promise<void>;
  loginAdmin: (
    username: string,
    password: string
  ) => Promise<{ requireMfa: boolean; partialToken?: string }>;
  verifyMfaCode: (code: string, partialToken: string) => Promise<void>;
  logout: () => void;
}

type AdminAuthContextType = AdminAuthState & AdminAuthActions;

const AdminAuthContext = createContext<AdminAuthContextType | null>(null);

const TOKEN_KEY = "yetiforge_admin_token";

export function AdminAuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() =>
    localStorage.getItem(TOKEN_KEY)
  );
  const [isSetUp, setIsSetUp] = useState<boolean | null>(null);
  const [mfaEnabled, setMfaEnabled] = useState(false);
  const [loading, setLoading] = useState(true);

  const saveToken = useCallback((t: string) => {
    localStorage.setItem(TOKEN_KEY, t);
    setToken(t);
  }, []);

  const clearToken = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    setToken(null);
  }, []);

  const checkSetupStatus = useCallback(async () => {
    try {
      const result = await api.getSetupStatus();
      setIsSetUp(result.isSetUp);
      setMfaEnabled(result.mfaEnabled);
    } catch {
      setIsSetUp(false);
    } finally {
      setLoading(false);
    }
  }, []);

  const setupAdmin = useCallback(
    async (username: string, password: string) => {
      const result = await api.setup(username, password);
      saveToken(result.token);
      setIsSetUp(true);
    },
    [saveToken]
  );

  const loginAdmin = useCallback(
    async (username: string, password: string) => {
      const result = await api.login(username, password);
      if (result.requireMfa) {
        return { requireMfa: true, partialToken: result.token };
      }
      saveToken(result.token);
      return { requireMfa: false };
    },
    [saveToken]
  );

  const verifyMfaCode = useCallback(
    async (code: string, partialToken: string) => {
      const result = await api.verifyMfa(code, partialToken);
      saveToken(result.token);
    },
    [saveToken]
  );

  const logout = useCallback(() => {
    clearToken();
  }, [clearToken]);

  useEffect(() => {
    checkSetupStatus();
  }, [checkSetupStatus]);

  return (
    <AdminAuthContext.Provider
      value={{
        token,
        isAuthenticated: !!token,
        isSetUp,
        mfaEnabled,
        loading,
        checkSetupStatus,
        setupAdmin,
        loginAdmin,
        verifyMfaCode,
        logout,
      }}
    >
      {children}
    </AdminAuthContext.Provider>
  );
}

export function useAdminAuth(): AdminAuthContextType {
  const ctx = useContext(AdminAuthContext);
  if (!ctx) throw new Error("useAdminAuth must be used within AdminAuthProvider");
  return ctx;
}
