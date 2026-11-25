/**
 * What the server does with the edge at its start, in an order that never
 * hands a proof to an edge with Traefik's API on (its API would show it):
 *
 *   1. Is this state dir's running edge serving the API (an edge started
 *      before Den refused such edge.args)?
 *   2. No: sync the proof into Den's dynamic file (syncEdgeProof).
 *   3. Yes: stop it before any proof is written, then recreate it without
 *      the API, with a new proof (`edge up --rotate-proof`), so a proof it
 *      may have shown never works again.
 *   4. A stop or recreate that fails holds edge trust back: no proof
 *      proves (edgeTrustHeld) until `edge up` succeeds, and doctor says
 *      why. Nothing is synced.
 *   5. A check that can't answer (Docker there but not answering) is no
 *      "no": trust is held back (`unsure`), nothing is synced, and
 *      edgeStartRetrying asks again until it answers.
 *
 * The caller holds trust back while this runs, and `release` ends it.
 */
export interface EdgeStartDeps {
  servesApi: () => Promise<boolean>;
  stop: () => Promise<void>;
  /** Recreate the edge without the API, with a new proof. */
  recreate: () => Promise<void>;
  sync: () => void;
  hold: (reason: string) => void;
  /** Hold trust back for this run only: the API check gave no answer. */
  unsure: (reason: string) => void;
  release: () => void;
  log: (line: string) => void;
}

export type EdgeStartOutcome = "synced" | "recreated" | "held" | "unsure";

const why = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).split("\n")[0];

export async function edgeStart(d: EdgeStartDeps): Promise<EdgeStartOutcome> {
  let api = false;
  try {
    api = await d.servesApi();
  } catch (e) {
    // servesApi says no itself when there's no edge or no Docker; an
    // error is no answer, and a proof must never reach an edge that may
    // serve the API.
    d.unsure(
      `couldn't tell whether the running edge has Traefik's API on (${why(e)})`,
    );
    return "unsure";
  }
  if (!api) {
    try {
      d.sync();
    } catch (e) {
      // A proof that can't be written stays of an older generation, which
      // proves nothing (proofIsCurrent): fails closed by itself.
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

/**
 * edgeStart, asked again every `everyMs` (edge.address_recheck_seconds)
 * while the API check gives no answer (Docker installed but not up yet,
 * say), so trust held back for that reason ends once Docker answers no
 * API, instead of lasting until the next start. An error or a timeout is
 * never that answer: trust stays held. Stops once Den is stopping.
 */
export async function edgeStartRetrying(
  d: EdgeStartDeps,
  o: {
    everyMs: number;
    later: (fn: () => void, ms: number) => void;
    /** Den is stopping: ask no more. */
    stopped?: () => boolean;
  },
): Promise<EdgeStartOutcome> {
  const out = await edgeStart(d);
  // One wait at a time, the setting's length and never under a second.
  if (out === "unsure" && !o.stopped?.())
    o.later(
      () => {
        if (!o.stopped?.()) void edgeStartRetrying(d, o);
      },
      Math.max(1000, o.everyMs),
    );
  return out;
}

/**
 * The hold an unsure API check keeps on edge trust (`trust.held`, the
 * server's in-process hold), as its own: `unsure` holds it with its reason
 * (true when that reason is new, to say once) and never replaces a hold
 * something else set; `release` ends only that hold, never one set before
 * or after it (the edge-up route failing meanwhile, say).
 */
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
