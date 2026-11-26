import { stripVTControlCharacters } from "node:util";
import { redactSecrets } from "../../shared/redact.js";
import { maskSecretValues } from "../../shared/secret-values.js";

// Every message written via serverLog() lands here in plain-text form (ANSI
// stripped) and fans out to any subscribers — primarily the /api/server-log
// SSE stream surfaced on the /logs page. Fixed-size ring so an idle server
// doesn't grow without bound; restart drops history (not persisted to disk).

export interface LogEntry {
  ts: string;
  kind: string;
  text: string;
  /** Set when an agent (via `<cli> mcp`) asked for this action: its label. */
  actor?: string;
}

export function createLogRing(max: number) {
  const ring: LogEntry[] = [];
  const subscribers = new Set<(e: LogEntry) => void>();
  return {
    push(kind: string, text: string, actor?: string): void {
      const entry: LogEntry = {
        ts: new Date().toISOString(),
        kind,
        text: maskSecretValues(redactSecrets(stripVTControlCharacters(text))),
        ...(actor ? { actor } : {}),
      };
      ring.push(entry);
      if (ring.length > max) ring.shift();
      for (const sub of subscribers) {
        try {
          sub(entry);
        } catch {
          /* subscriber broke — don't let it take the server down */
        }
      }
    },
    history: (): LogEntry[] => ring.slice(),
    subscribe(fn: (e: LogEntry) => void): () => void {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
  };
}
