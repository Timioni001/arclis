/**
 * Talking to the assistant endpoint.
 *
 * Deliberately thin. The tool loop, the model choice and the key all live on
 * the server; this reads Server-Sent Events and hands back text deltas. If the
 * endpoint is not configured the assistant simply does not appear, rather than
 * appearing and failing.
 */

export interface AssistantMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AssistantHandlers {
  onDelta(text: string): void;
  /** A lookup started. Used to show what it is checking. */
  onTool(name: string): void;
  onError(message: string): void;
  onDone(): void;
}

const ENDPOINT = import.meta.env.VITE_ASSISTANT_URL?.trim() ?? "";

export function assistantConfigured(): boolean {
  return ENDPOINT.length > 0;
}

/**
 * Send a turn and stream the reply.
 *
 * Returns an abort function. Streaming responses have to be cancellable or a
 * closed panel keeps a request alive and keeps spending.
 */
export function askAssistant(
  messages: AssistantMessage[],
  handlers: AssistantHandlers,
): () => void {
  if (!ENDPOINT) {
    handlers.onError("The assistant is not configured on this deployment.");
    handlers.onDone();
    return () => {};
  }

  const controller = new AbortController();

  void (async () => {
    try {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        const detail = await response
          .json()
          .then((d: { error?: string }) => d.error)
          .catch(() => null);
        handlers.onError(detail ?? "The assistant is unavailable right now.");
        handlers.onDone();
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE frames are separated by a blank line. A partial frame stays in
        // the buffer until its terminator arrives; parsing on chunk boundaries
        // instead would split JSON payloads at random.
        let split: number;
        while ((split = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);

          const event = frame.match(/^event: (.+)$/m)?.[1];
          const raw = frame.match(/^data: (.+)$/m)?.[1];
          if (!event || !raw) continue;

          let data: Record<string, string>;
          try {
            data = JSON.parse(raw);
          } catch {
            continue;
          }

          if (event === "delta") handlers.onDelta(data.text ?? "");
          else if (event === "tool") handlers.onTool(data.name ?? "");
          else if (event === "error")
            handlers.onError(data.message ?? "Failed.");
          else if (event === "done") handlers.onDone();
        }
      }
      handlers.onDone();
    } catch (e) {
      // An abort is the user closing the panel, not a failure to report.
      if (e instanceof DOMException && e.name === "AbortError") return;
      handlers.onError("Could not reach the assistant.");
      handlers.onDone();
    }
  })();

  return () => controller.abort();
}

/** What the tools are called, in words a person reads. */
export const TOOL_LABELS: Record<string, string> = {
  lookup_token: "Checking the registry",
  list_tokens: "Listing covered tokens",
  list_launches: "Reading Clawpump launches",
};
