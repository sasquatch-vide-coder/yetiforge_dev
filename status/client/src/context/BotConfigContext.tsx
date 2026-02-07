import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";

interface BotConfigContextType {
  botName: string;
  loading: boolean;
  refetch: () => void;
}

const BotConfigContext = createContext<BotConfigContextType | null>(null);

export function BotConfigProvider({ children }: { children: ReactNode }) {
  const [botName, setBotName] = useState("YETIFORGE");
  const [loading, setLoading] = useState(true);

  const fetchConfig = useCallback(async () => {
    try {
      const res = await fetch("/api/bot/config");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.botName) {
        setBotName(data.botName);
      }
    } catch {
      // Keep default on error
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  // Set document title whenever botName changes
  useEffect(() => {
    document.title = `${botName} Status`;
  }, [botName]);

  return (
    <BotConfigContext.Provider value={{ botName, loading, refetch: fetchConfig }}>
      {children}
    </BotConfigContext.Provider>
  );
}

export function useBotName(): BotConfigContextType {
  const ctx = useContext(BotConfigContext);
  if (!ctx)
    throw new Error("useBotName must be used within BotConfigProvider");
  return ctx;
}
