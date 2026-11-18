/**
 * Issue 395: the one edge_up path. Settings' Start the edge (Apply), the
 * server agent's held edge_up, Den's own offer after a config change, and
 * the doctor's hint (issue 519) all call applyEdgeConfig: an optional
 * config change first, then what `edge up` runs (runEdgeUp), one at a
 * time. It answers what happened, with edge_status: the image, its
 * Traefik version, whether the edge was recreated, and why (#385).
 *
 * edgeDrift says what the running edge and the config disagree on, for
 * edge.image and edge.args (the command flags they make): "the edge runs
 * X; the config says Y".
 */
import { clearReadCache } from "../read-cache.js";
import { readEdgeConfig } from "./config.js";
import { edgeNames } from "./render.js";
import { inspectEdge, localImageId, realOrSelf } from "./runtime.js";
import {
  edgeChangesText,
  edgeSpecChanges,
  edgeUpLine,
  renderedEdgeSpec,
  type EdgeChange,
  type EdgeSpec,
  type EdgeUpKind,
  type EdgeUpOutcome,
  type RunningEdge,
} from "./spec.js";
import type { EdgeConfig } from "./types.js";

/** An image, and the Traefik version its tag names (null: Den can't tell). */
export interface EdgeImageView {
  image: string;
  version: string | null;
}

/** What the running edge and the config disagree on (image, args). */
export interface EdgeDrift {
  running: EdgeImageView;
  config: EdgeImageView;
  changes: EdgeChange[];
  /** What the edge runs, and what the config says, in words. */
  runs: string;
  says: string;
  /** "the edge runs X; the config says Y" */
  line: string;
}

/** edge_status in edge_up's answer. */
export interface EdgeUpStatus {
  image: string;
  version: string | null;
  recreated: boolean;
  kind: EdgeUpKind;
  why: string;
}

/** What applyEdgeConfig did. */
export interface EdgeApplied {
  outcome: EdgeUpOutcome;
  /** `edge up`'s own line for it. */
  line: string;
  edge_status: EdgeUpStatus;
}

/** The Traefik version an image's tag names (`traefik:v3.7.17` → 3.7.17). */
export function traefikVersion(image: string): string | null {
  const ref = image.trim().split("@")[0] ?? "";
  const last = ref.slice(ref.lastIndexOf("/") + 1);
  const colon = last.indexOf(":");
  if (colon < 0 || last.slice(0, colon).toLowerCase() !== "traefik")
    return null;
  const m = /^v?(\d+(?:\.\d+)*)(?:[-+].*)?$/i.exec(last.slice(colon + 1));
  return m ? m[1] : null;
}

const view = (image: string): EdgeImageView => ({
  image,
  version: traefikVersion(image),
});

/**
 * The drift between a running edge and the spec Den renders now, for the
 * image and the command flags (edge.args, and what the config turns into
 * flags); null when it isn't running or they agree.
 */
export function edgeDriftFrom(
  cfg: EdgeConfig,
  running: RunningEdge | null,
  rendered: EdgeSpec,
  real?: (p: string) => string,
): EdgeDrift | null {
  if (!running?.running) return null;
  const changes = edgeSpecChanges(running.spec, rendered, real).filter(
    (c) => c.field === "image" || c.field.startsWith("--"),
  );
  if (!changes.length) return null;
  const image = changes.find((c) => c.field === "image");
  const runs = image
    ? image.old
    : changes.map((c) => `${c.field}: ${c.old}`).join(", ");
  const says = image
    ? image.new
    : changes.map((c) => `${c.field}: ${c.new}`).join(", ");
  return {
    running: view(running.spec.image),
    config: view(cfg.image),
    changes,
    runs,
    says,
    line: `the edge runs ${runs}; the config says ${says}`,
  };
}

/** The drift now: the running container (docker inspect) against the config. */
export function edgeDrift(
  cfg: EdgeConfig = readEdgeConfig(),
): EdgeDrift | null {
  try {
    const running = inspectEdge(edgeNames(cfg.org).container);
    if (!running?.running) return null;
    return edgeDriftFrom(
      cfg,
      running,
      renderedEdgeSpec(cfg, realOrSelf(cfg.stateDir), localImageId(cfg.image)),
      realOrSelf,
    );
  } catch {
    return null; // no docker here
  }
}

/** edge_status for an outcome: the image, recreated or not, and why. */
export function edgeUpStatus(
  cfg: Pick<EdgeConfig, "image">,
  o: EdgeUpOutcome,
): EdgeUpStatus {
  const why =
    o.kind === "started"
      ? "no edge was running, so Den started it"
      : o.kind === "current"
        ? "the running edge already matches the config; nothing restarted"
        : o.changes.length
          ? edgeChangesText(o.changes)
          : "its settings changed";
  return {
    ...view(cfg.image),
    recreated: o.kind === "recreated",
    kind: o.kind,
    why,
  };
}

/** One edge_up runs already. */
export class EdgeUpBusy extends Error {
  constructor() {
    super("The edge is already starting. Wait for it.");
    this.name = "EdgeUpBusy";
  }
}

let inFlight = false;

/**
 * Apply the edge config: `change` first (issue 519: write a config
 * change), then what `edge up` runs. One at a time: a second call while
 * one runs throws EdgeUpBusy. `up` is `edge up` itself (tests pass a fake).
 */
export async function applyEdgeConfig(
  opts: {
    change?: () => void | Promise<void>;
    log?: (line: string) => void;
    up?: (o: {
      log?: (line: string) => void;
    }) => Promise<{ cfg: EdgeConfig; outcome: EdgeUpOutcome }>;
  } = {},
): Promise<EdgeApplied> {
  if (inFlight) throw new EdgeUpBusy();
  inFlight = true;
  try {
    if (opts.change) {
      await opts.change();
      // The server's read cache must not hand edge up the old config.
      clearReadCache();
    }
    const up =
      opts.up ??
      (async (o: { log?: (line: string) => void }) =>
        (await import("./up.js")).runEdgeUp({ log: o.log }));
    const { cfg, outcome } = await up({ log: opts.log });
    return {
      outcome,
      line: edgeUpLine(outcome),
      edge_status: edgeUpStatus(cfg, outcome),
    };
  } finally {
    inFlight = false;
  }
}
