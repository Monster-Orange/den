export interface EdgeStartDeps {
  servesApi: () => Promise<boolean>;
  stop: () => Promise<void>;
  recreate: () => Promise<void>;
  sync: () => void;
  hold: (reason: string) => void;
  unsure: (reason: string) => void;
  release: () => void;
  log: (line: string) => void;
}

export type EdgeStartOutcome = "synced" | "recreated" | "held" | "unsure";

const why = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).split("\n")[0];

// An edge serving Traefik's API is stopped before any proof is written; a
// check, stop or recreate that fails holds trust back (fails closed).
export async function edgeStart(d: EdgeStartDeps): Promise<EdgeStartOutcome> {
  let api = false;
  try {
    api = await d.servesApi();
  } catch (e) {
    d.unsure(
      `couldn't tell whether the running edge has Traefik's API on (${why(e)})`,
    );
    return "unsure";
  }
  if (!api) {
    try {
      d.sync();
    } catch (e) {
      d.log(`edge proof not synced: ${why(e)}`);
    }
    d.release();
    return "synced";
  }
  d.log(
    "the running edge has Traefik's API on: stopping it, then recreating it without",
  );
  try {
    await d.stop();
  } catch (e) {
    d.hold(
      `the running edge has Traefik's API on and couldn't be stopped (${why(e)})`,
    );
    return "held";
  }
  try {
    await d.recreate();
  } catch (e) {
    d.hold(
      `the edge was stopped (it had Traefik's API on) and couldn't be recreated (${why(e)})`,
    );
    return "held";
  }
  d.release();
  return "recreated";
}

export async function edgeStartRetrying(
  d: EdgeStartDeps,
  o: {
    everyMs: number;
    later: (fn: () => void, ms: number) => void;
    stopped?: () => boolean;
  },
): Promise<EdgeStartOutcome> {
  const out = await edgeStart(d);
  if (out === "unsure" && !o.stopped?.())
    o.later(
      () => {
        if (!o.stopped?.()) void edgeStartRetrying(d, o);
      },
      Math.max(1000, o.everyMs),
    );
  return out;
}

export function unsureHold(trust: { held: string | null }): {
  unsure: (reason: string) => boolean;
  release: () => void;
} {
  let mine: string | null = null;
  let said: string | null = null;
  return {
    unsure(reason) {
      if (trust.held === null || trust.held === mine) {
        trust.held = reason;
        mine = reason;
      }
      const fresh = said !== reason;
      said = reason;
      return fresh;
    },
    release() {
      if (mine !== null && trust.held === mine) trust.held = null;
      mine = null;
      said = null;
    },
  };
}
