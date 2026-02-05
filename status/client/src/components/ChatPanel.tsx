import { useState, useRef, useEffect } from "react";
import { sendChatMessage, resetChatSession, getChatHistory } from "../lib/adminApi";
import type { ChatSSEEvent } from "../lib/adminApi";

interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "status" | "work_result";
  text: string;
  timestamp: number;
  phase?: string;
  workMeta?: {
    overallSuccess: boolean;
    totalCostUsd: number;
    workerCount: number;
  };
}

export function ChatPanel({ token }: { token: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [statusText, setStatusText] = useState("");
  const [abortFn, setAbortFn] = useState<(() => void) | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, statusText]);

  useEffect(() => {
    if (!isProcessing) {
      inputRef.current?.focus();
    }
  }, [isProcessing]);

  // Restore chat history on mount
  useEffect(() => {
    (async () => {
      try {
        const { messages: history } = await getChatHistory(token);
        if (history && history.length > 0) {
          const restored: ChatMessage[] = history.map((msg) => ({
            id: msg.id || `${msg.role}-${msg.timestamp}`,
            role: msg.role,
            text: msg.text,
            timestamp: msg.timestamp,
            phase: msg.phase,
            workMeta: msg.workMeta,
          }));
          setMessages(restored);
        }
      } catch {
        // Silently fail - just start with empty history
      }
    })();
  }, [token]);

  const handleSend = () => {
    const text = input.trim();
    if (!text || isProcessing) return;

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      text,
      timestamp: Date.now(),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setIsProcessing(true);
    setStatusText("Connecting...");

    const { abort } = sendChatMessage(text, token, (event: ChatSSEEvent) => {
      switch (event.type) {
        case "status":
          setStatusText(event.data.message || "Working...");
          break;

        case "chat_response":
          setStatusText("");
          setMessages((prev) => [
            ...prev,
            {
              id: `assistant-${Date.now()}`,
              role: "assistant",
              text: event.data.text,
              timestamp: Date.now(),
            },
          ]);
          if (event.data.hasWork) {
            setStatusText("Starting background work...");
          }
          break;

        case "work_complete":
          setStatusText("");
          setMessages((prev) => [
            ...prev,
            {
              id: `work-${Date.now()}`,
              role: "work_result",
              text: event.data.summary,
              timestamp: Date.now(),
              workMeta: {
                overallSuccess: event.data.overallSuccess,
                totalCostUsd: event.data.totalCostUsd,
                workerCount: event.data.workerCount,
              },
            },
          ]);
          break;

        case "error":
          setStatusText("");
          setMessages((prev) => [
            ...prev,
            {
              id: `error-${Date.now()}`,
              role: "status",
              text: `Error: ${event.data.message}`,
              timestamp: Date.now(),
              phase: "error",
            },
          ]);
          setIsProcessing(false);
          setAbortFn(null);
          break;

        case "done":
          setStatusText("");
          setIsProcessing(false);
          setAbortFn(null);
          break;
      }
    });

    setAbortFn(() => abort);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleCancel = () => {
    if (abortFn) {
      abortFn();
      setIsProcessing(false);
      setStatusText("");
      setAbortFn(null);
      setMessages((prev) => [
        ...prev,
        {
          id: `cancel-${Date.now()}`,
          role: "status",
          text: "Request cancelled.",
          timestamp: Date.now(),
          phase: "cancelled",
        },
      ]);
    }
  };

  const handleReset = async () => {
    try {
      await resetChatSession(token);
      setMessages([]);
      setStatusText("");
    } catch {
      // Silently fail
    }
  };

  return (
    <div className="flex flex-col h-[calc(100vh-240px)] md:h-[calc(100vh-220px)] min-h-[500px] w-full max-w-full overflow-hidden">
      {/* Chat Header */}
      <div className="flex items-center justify-between mb-4 gap-2">
        <div className="min-w-0 flex-shrink">
          <h2 className="text-lg md:text-xl font-bold uppercase font-mono">Web Chat</h2>
          <p className="text-xs text-brutal-black/50 font-mono uppercase hidden md:block">
            Direct line to Tiffany
          </p>
        </div>
        <button
          onClick={handleReset}
          disabled={isProcessing}
          className="bg-brutal-orange text-brutal-white font-bold uppercase py-2 px-3 md:px-4 brutal-border hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none brutal-shadow transition-all text-xs font-mono disabled:opacity-50 flex-shrink-0"
        >
          New Session
        </button>
      </div>

      {/* Messages Area */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden bg-brutal-white brutal-border p-2 md:p-4 space-y-3 mb-4 min-w-0">
        {messages.length === 0 && (
          <div className="flex items-center justify-center h-full">
            <p className="text-brutal-black/30 font-mono text-sm uppercase">
              Send a message to start chatting
            </p>
          </div>
        )}

        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}

        {/* Status indicator */}
        {statusText && (
          <div className="flex items-start gap-2">
            <div className="bg-brutal-yellow/30 brutal-border px-3 py-2 max-w-[80%]">
              <div className="flex items-center gap-2">
                <span className="inline-block w-2 h-2 bg-brutal-yellow rounded-full animate-pulse" />
                <span className="font-mono text-xs text-brutal-black/70">
                  {statusText}
                </span>
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input Area */}
      <div className="flex gap-2 md:gap-3 min-w-0 w-full overflow-hidden">
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a message..."
          disabled={isProcessing}
          rows={2}
          className="flex-1 p-2 md:p-3 brutal-border font-mono text-sm bg-brutal-bg resize-none focus:outline-none focus:ring-2 focus:ring-brutal-black disabled:opacity-50 min-w-0 overflow-x-hidden"
        />
        {isProcessing ? (
          <button
            onClick={handleCancel}
            className="bg-brutal-red text-brutal-white font-bold uppercase py-2 px-3 md:px-6 brutal-border hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none brutal-shadow transition-all text-xs md:text-sm font-mono self-end flex-shrink-0"
          >
            Cancel
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={!input.trim()}
            className="bg-brutal-black text-brutal-white font-bold uppercase py-2 px-3 md:px-6 brutal-border hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none brutal-shadow transition-all text-xs md:text-sm font-mono disabled:opacity-50 self-end flex-shrink-0"
          >
            Send
          </button>
        )}
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const time = new Date(message.timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="bg-brutal-black text-brutal-white brutal-border px-4 py-3 max-w-[80%] min-w-0">
          <p className="font-mono text-sm whitespace-pre-wrap break-words overflow-wrap-anywhere">{message.text}</p>
          <p className="text-xs text-brutal-white/50 mt-1 font-mono text-right">
            {time}
          </p>
        </div>
      </div>
    );
  }

  if (message.role === "assistant") {
    return (
      <div className="flex justify-start">
        <div className="bg-brutal-blue/10 brutal-border px-4 py-3 max-w-[80%] min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-bold text-xs uppercase font-mono text-brutal-blue">
              Tiffany
            </span>
          </div>
          <p className="font-mono text-sm whitespace-pre-wrap break-words overflow-wrap-anywhere">{message.text}</p>
          <p className="text-xs text-brutal-black/40 mt-1 font-mono">{time}</p>
        </div>
      </div>
    );
  }

  if (message.role === "work_result") {
    return (
      <div className="flex justify-start">
        <div
          className={`brutal-border px-4 py-3 max-w-[80%] min-w-0 ${
            message.workMeta?.overallSuccess
              ? "bg-brutal-green/10"
              : "bg-brutal-red/10"
          }`}
        >
          <div className="flex items-center gap-2 mb-1">
            <span
              className={`font-bold text-xs uppercase font-mono ${
                message.workMeta?.overallSuccess
                  ? "text-brutal-green"
                  : "text-brutal-red"
              }`}
            >
              {message.workMeta?.overallSuccess
                ? "Work Complete"
                : "Work Failed"}
            </span>
          </div>
          <p className="font-mono text-sm whitespace-pre-wrap break-words overflow-wrap-anywhere">{message.text}</p>
          {message.workMeta && (
            <div className="flex flex-wrap gap-4 mt-2 text-xs font-mono text-brutal-black/50">
              <span>
                Workers: {message.workMeta.workerCount}
              </span>
              <span>
                Cost: ${message.workMeta.totalCostUsd.toFixed(4)}
              </span>
            </div>
          )}
          <p className="text-xs text-brutal-black/40 mt-1 font-mono">{time}</p>
        </div>
      </div>
    );
  }

  // Status/error messages
  return (
    <div className="flex justify-center">
      <div
        className={`px-3 py-1 font-mono text-xs ${
          message.phase === "error"
            ? "text-brutal-red"
            : message.phase === "cancelled"
            ? "text-brutal-orange"
            : "text-brutal-black/50"
        }`}
      >
        {message.text}
      </div>
    </div>
  );
}
