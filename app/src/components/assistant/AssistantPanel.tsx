/**
 * The assistant, as a panel.
 *
 * It does not open itself, it does not greet anyone, and it is not a bubble in
 * the corner of every screen. It sits on the registry, where the question it
 * answers is the question a person is already asking, and it is hidden
 * entirely when the endpoint is not configured. An assistant that appears and
 * then fails is worse than no assistant.
 */

import { useEffect, useRef, useState } from "react";
import {
  askAssistant,
  assistantConfigured,
  TOOL_LABELS,
  type AssistantMessage,
} from "../../lib/assistant/client";
import { GlassPanel } from "../ui/Glass";
import { Icon } from "../ui";

const SUGGESTIONS = [
  "What am I actually holding if I own AAPLx?",
  "Why is preOPENAI trading 17% above its reference?",
  "Which of these can I actually redeem for a share?",
];

export function AssistantPanel() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [tool, setTool] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<(() => void) | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [messages, streaming]);

  // A closed panel must not keep a stream alive; that is somebody's bill.
  useEffect(() => {
    if (!open) {
      abortRef.current?.();
      abortRef.current = null;
      setStreaming(false);
    }
  }, [open]);

  useEffect(() => () => abortRef.current?.(), []);

  // Not configured means not rendered: no teaser, no disabled button. This
  // check sits below every hook deliberately - returning before them would
  // change the hook count between renders the moment the flag did.
  if (!assistantConfigured()) return null;

  function send(text: string) {
    const question = text.trim();
    if (!question || streaming) return;

    const next: AssistantMessage[] = [
      ...messages,
      { role: "user", content: question },
    ];
    setMessages([...next, { role: "assistant", content: "" }]);
    setDraft("");
    setError(null);
    setStreaming(true);
    setTool(null);

    abortRef.current = askAssistant(next, {
      onDelta(chunk) {
        setMessages((current) => {
          const copy = [...current];
          const last = copy[copy.length - 1];
          if (last?.role === "assistant") {
            copy[copy.length - 1] = { ...last, content: last.content + chunk };
          }
          return copy;
        });
      },
      onTool: setTool,
      onError(message) {
        setError(message);
        // Drop the empty assistant turn so a failed answer does not leave a
        // blank bubble in the transcript.
        setMessages((current) => {
          const last = current[current.length - 1];
          return last?.role === "assistant" && last.content === ""
            ? current.slice(0, -1)
            : current;
        });
      },
      onDone() {
        setStreaming(false);
        setTool(null);
        abortRef.current = null;
      },
    });
  }

  if (!open) {
    return (
      <button className="assistant-open" onClick={() => setOpen(true)}>
        <Icon name="target" size={16} />
        Ask what you are holding
      </button>
    );
  }

  return (
    <GlassPanel
      weight="panel"
      radius={24}
      className="assistant-shell"
      innerClassName="assistant crisp"
      as="section"
    >
      <header className="assistant-head">
        <div>
          <div className="eyebrow-mono">Registry assistant</div>
          <p>
            Grounded in the same scoring this page renders. It looks things up
            rather than recalling them, and it does not give investment advice.
          </p>
        </div>
        <button
          className="icon-btn assistant-close"
          onClick={() => setOpen(false)}
          aria-label="Close"
        >
          <Icon name="plus" size={18} />
        </button>
      </header>

      <div className="assistant-log" ref={logRef} aria-live="polite">
        {messages.length === 0 && (
          <ul className="assistant-suggestions">
            {SUGGESTIONS.map((s) => (
              <li key={s}>
                <button onClick={() => send(s)}>{s}</button>
              </li>
            ))}
          </ul>
        )}

        {messages.map((m, i) => (
          <div className="assistant-turn" data-role={m.role} key={i}>
            {m.content ||
              (streaming && i === messages.length - 1 ? (
                <span className="assistant-thinking">
                  {tool ? (TOOL_LABELS[tool] ?? "Looking it up") : "Thinking"}
                  <span className="assistant-dots" aria-hidden />
                </span>
              ) : null)}
          </div>
        ))}

        {error && (
          <p className="assistant-error" role="alert">
            {error}
          </p>
        )}
      </div>

      <form
        className="assistant-compose"
        onSubmit={(e) => {
          e.preventDefault();
          send(draft);
        }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Ask about a ticker, a price gap, or who can redeem"
          aria-label="Ask the assistant"
          disabled={streaming}
        />
        <button
          type="submit"
          disabled={streaming || !draft.trim()}
          aria-label="Send"
        >
          <Icon name="send" size={16} />
        </button>
      </form>
    </GlassPanel>
  );
}
