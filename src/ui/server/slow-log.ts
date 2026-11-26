export type CallerKind = "person" | "agent" | "cli" | "runner" | "unsigned";

export function callerKind(p: { kind: string } | null | undefined): CallerKind {
  switch (p?.kind) {
    case "person-browser":
      return "person";
    case "agent":
      return "agent";
    case "person":
      return "cli";
    case "gate-runner":
      return "runner";
    default:
      return "unsigned";
  }
}

const held = (more: number) =>
  more > 0 ? `; ${more} more like it not logged` : "";

export function slowRequestLine(o: {
  method: string;
  pattern: string;
  ms: number;
  caller: CallerKind;
  more: number;
}): string {
  return (
    `  ⚠ slow request: ${o.method.toUpperCase()} ${o.pattern} took ${Math.round(o.ms)} ms (${o.caller})` +
    held(o.more)
  );
}

export function lagLine(ms: number, more: number): string {
  return (
    `  ⚠ event loop blocked for ${Math.round(ms)} ms: no request or timer ran` +
    held(more)
  );
}

export function rateLimit(o: {
  windowMs: number;
  now: () => number;
  maxKeys?: number;
}): (key: string) => number | null {
  const seen = new Map<string, { at: number; held: number }>();
  const maxKeys = o.maxKeys ?? 500;
  return (key) => {
    const t = o.now();
    const k = seen.get(key);
    if (k && t - k.at < o.windowMs) {
      k.held++;
      return null;
    }
    if (!k && seen.size >= maxKeys) seen.clear();
    seen.set(key, { at: t, held: 0 });
    return k ? k.held : 0;
  };
}

export function lagWatch(o: {
  everyMs: number;
  now: () => number;
  setInterval: (f: () => void, ms: number) => { unref?: () => void };
  clearInterval: (t: { unref?: () => void }) => void;
  onLag: (ms: number) => void;
}): { stop(): void } {
  let last = o.now();
  const t = o.setInterval(() => {
    const n = o.now();
    const late = n - last - o.everyMs;
    last = n;
    if (late > 0) o.onLag(late);
  }, o.everyMs);
  t.unref?.();
  return { stop: () => o.clearInterval(t) };
}
