/**
 * Issue 395: Den offers the edge's Allow itself. When a config merge
 * changes edge.image or edge.args, the edge that runs no longer matches
 * the config: Den holds an edge_up for the person without being asked,
 * saying "the edge runs X; the config says Y". Once per change: the same
 * config again offers nothing more. The Allow runs the one edge_up path
 * (applyEdgeConfig), the one Settings' button runs too.
 *
 * A fixture distribution in a temp dir (config/den.yml, user.yml); the
 * running edge is a fake made from the spec Den renders, and the edge
 * runner is a fake: nothing reaches Docker.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readEdgeConfig } from "../../../src/shared/edge/config.js";
import {
  renderedEdgeSpec,
  type RunningEdge,
} from "../../../src/shared/edge/spec.js";
import {
  edgeDriftFrom,
  type EdgeApplied,
} from "../../../src/shared/edge/apply.js";
import type { EdgeConfig } from "../../../src/shared/edge/types.js";
import {
  EDGE_OFFER_ACTOR,
  createEdgeOffer,
  edgeUpHeld,
} from "../../../src/ui/server/edge-offer.js";
import { createApprovalQueue } from "../../../src/ui/server/approval-routes.js";

let root = "";
const team = (image: string) =>
  `edge:\n  org: acme\n  domain: acme.localhost\n  image: ${image}\n  state_dir: ${path.join(root, "edge")}\n`;
const writeTeam = (image: string) =>
  fs.writeFileSync(path.join(root, "config", "den.yml"), team(image));

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "edge-offer-"));
  fs.mkdirSync(path.join(root, "config", "local"), { recursive: true });
  writeTeam("traefik:v3.7.17");
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

/** The edge running as the config is now (a fake `docker inspect`). */
function runningNow(): RunningEdge {
  const cfg = readEdgeConfig(root);
  return {
    id: "c0ffee",
    running: true,
    startedAt: "2026-11-18T10:00:00Z",
    spec: renderedEdgeSpec(cfg, cfg.stateDir),
  };
}

function setup() {
  const running = runningNow();
  const applied: string[] = [];
  const apply = async (): Promise<EdgeApplied> => {
    applied.push(readEdgeConfig(root).image);
    return {
      outcome: { kind: "recreated", changes: [], downSeconds: 2 },
      line: "Edge recreated",
      edge_status: {
        image: readEdgeConfig(root).image,
        version: "3.8.0",
        recreated: true,
        kind: "recreated",
        why: "image",
      },
    };
  };
  const drift = (cfg: EdgeConfig) =>
    edgeDriftFrom(cfg, running, renderedEdgeSpec(cfg, cfg.stateDir));
  const held = edgeUpHeld({
    image: () => readEdgeConfig(root).image,
    drift: () => drift(readEdgeConfig(root)),
    apply,
  });
  const queue = createApprovalQueue({ edge_up: held }, () => root);
  const offer = createEdgeOffer({
    config: () => readEdgeConfig(root),
    drift,
    queue: () => queue,
    action: held,
  });
  return { queue, offer, applied };
}

describe("issue 395: a config change offers the edge's Allow", () => {
  it("the config the edge runs: nothing offered; edge.image changed: an edge_up waits for the person", async () => {
    const { queue, offer } = setup();
    expect(await offer.tick()).toBeNull();
    expect(queue.pending()).toEqual([]);

    writeTeam("traefik:v3.8.0"); // the merge
    const a = await offer.tick();
    expect(a).not.toBeNull();
    const pending = queue.pending();
    expect(pending.map((p) => [p.action, p.actor])).toEqual([
      ["edge_up", EDGE_OFFER_ACTOR],
    ]);
    expect(pending[0].summary).toContain(
      "the edge runs traefik:v3.7.17; the config says traefik:v3.8.0",
    );

    // The same config again: no second offer.
    expect(await offer.tick()).toBeNull();
    expect(queue.pending().length).toBe(1);
  });

  it("edge.args changed in user.yml: offered too", async () => {
    const { queue, offer } = setup();
    expect(await offer.tick()).toBeNull();
    fs.writeFileSync(
      path.join(root, "config", "local", "user.yml"),
      "edge:\n  args: [--metrics.prometheus=true]\n",
    );
    expect(await offer.tick()).not.toBeNull();
    expect(queue.pending()[0].summary).toContain("--metrics.prometheus");
  });

  it("the person's Allow runs the one edge_up path, and its answer carries edge_status", async () => {
    const { queue, offer, applied } = setup();
    await offer.tick();
    writeTeam("traefik:v3.8.0");
    const a = (await offer.tick())!;
    const r = await queue.decide(a.id, "allow", "person:me");
    expect(r.ok).toBe(true);
    expect(applied).toEqual(["traefik:v3.8.0"]);
    const done = queue.get(a.id)!;
    expect(done.state).toBe("done");
    expect(done.result).toMatchObject({
      ok: true,
      edge_status: { image: "traefik:v3.8.0", recreated: true },
    });
  });

  it("a project's agent can't ask for edge_up: the edge is every project's", async () => {
    const held = edgeUpHeld({
      image: () => "traefik:v3.7.17",
      drift: () => null,
      apply: async () => {
        throw new Error("never");
      },
    });
    const c = await held.check({}, { project: "north", agent: "scout" });
    expect(c.ok).toBe(false);
  });
});
