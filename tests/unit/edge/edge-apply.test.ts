/**
 * Issue 395: the one edge_up path (shared/edge/apply.ts). Settings' Start
 * the edge button, the server agent's held edge_up and the doctor's hint
 * (issue 519) all call applyEdgeConfig: an optional config change first,
 * then what `edge up` runs, one at a time. Its answer carries edge_status:
 * the image, its version, whether the edge was recreated, and why.
 *
 * edgeDriftFrom says what the running edge and the config disagree on
 * (edge.image, edge.args): "the edge runs X; the config says Y". The edge
 * runner is a fake: nothing reaches Docker.
 */
import { describe, expect, it } from "@jest/globals";
import {
  EdgeUpBusy,
  applyEdgeConfig,
  edgeDriftFrom,
  edgeUpStatus,
  traefikVersion,
} from "../../../src/shared/edge/apply.js";
import {
  renderedEdgeSpec,
  type EdgeUpOutcome,
} from "../../../src/shared/edge/spec.js";
import type { EdgeConfig } from "../../../src/shared/edge/types.js";

const cfg = (o: Partial<EdgeConfig> = {}): EdgeConfig =>
  ({
    org: "acme",
    domain: "acme.localhost",
    aliases: [],
    image: "traefik:v3.7.17",
    workspaces: ["main"],
    subzones: [],
    routes: {},
    ports: { http: 80, https: 443 },
    stateDir: "/tmp/acme-edge",
    tls: { strategy: "none" },
    tlsFrom: "explicit",
    httpsRedirect: false,
    dockerLabels: null,
    include: null,
    mounts: {},
    networks: [],
    args: [],
    proxyProtocolTrustedIps: [],
    upstreamIdleSeconds: 1,
    ...o,
  }) as EdgeConfig;

const running = (c: EdgeConfig) => ({
  id: "c1",
  running: true,
  startedAt: "2026-11-18T10:00:00Z",
  spec: renderedEdgeSpec(c, c.stateDir),
});

describe("issue 395: the edge and its config", () => {
  it("reads the Traefik version from the image's tag", () => {
    expect(traefikVersion("traefik:v3.7.17")).toBe("3.7.17");
    expect(traefikVersion("docker.io/library/traefik:3.8")).toBe("3.8");
    expect(traefikVersion("traefik@sha256:abab")).toBeNull();
    expect(traefikVersion("traefik:latest")).toBeNull();
  });

  it("no drift when the edge runs the config; image or args changed: the edge runs X; the config says Y", () => {
    const a = cfg();
    const r = running(a);
    expect(edgeDriftFrom(a, r, renderedEdgeSpec(a, a.stateDir))).toBeNull();
    expect(edgeDriftFrom(a, null, renderedEdgeSpec(a, a.stateDir))).toBeNull();

    const b = cfg({ image: "traefik:v3.8.0" });
    const d = edgeDriftFrom(b, r, renderedEdgeSpec(b, b.stateDir))!;
    expect(d.running).toEqual({ image: "traefik:v3.7.17", version: "3.7.17" });
    expect(d.config).toEqual({ image: "traefik:v3.8.0", version: "3.8.0" });
    expect(d.line).toBe(
      "the edge runs traefik:v3.7.17; the config says traefik:v3.8.0",
    );

    const c = cfg({ args: ["--metrics.prometheus=true"] });
    const e = edgeDriftFrom(c, r, renderedEdgeSpec(c, c.stateDir))!;
    expect(e.line).toBe(
      "the edge runs --metrics.prometheus: none; the config says --metrics.prometheus: true",
    );
  });

  it("edge_status says recreated or not, and why", () => {
    const c = cfg({ image: "traefik:v3.8.0" });
    const rec: EdgeUpOutcome = {
      kind: "recreated",
      changes: [
        { field: "image", old: "traefik:v3.7.17", new: "traefik:v3.8.0" },
      ],
      downSeconds: 4,
    };
    expect(edgeUpStatus(c, rec)).toEqual({
      image: "traefik:v3.8.0",
      version: "3.8.0",
      recreated: true,
      kind: "recreated",
      why: "image: traefik:v3.7.17 → traefik:v3.8.0",
    });
    expect(
      edgeUpStatus(c, { kind: "current", changes: [], downSeconds: null }),
    ).toMatchObject({
      recreated: false,
      kind: "current",
      why: expect.stringMatching(/already/),
    });
    expect(
      edgeUpStatus(c, { kind: "started", changes: [], downSeconds: null }),
    ).toMatchObject({
      recreated: false,
      kind: "started",
      why: expect.stringMatching(/no edge was running/),
    });
  });

  it("applyEdgeConfig: the change first, then edge up; one at a time", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const up = async () => {
      order.push("up");
      await gate;
      return {
        cfg: cfg({ image: "traefik:v3.8.0" }),
        outcome: {
          kind: "started",
          changes: [],
          downSeconds: null,
        } as EdgeUpOutcome,
      };
    };
    const first = applyEdgeConfig({
      change: () => void order.push("change"),
      up,
    });
    await expect(applyEdgeConfig({ up })).rejects.toBeInstanceOf(EdgeUpBusy);
    release();
    const r = await first;
    expect(order).toEqual(["change", "up"]);
    expect(r.line).toBe("Edge started");
    expect(r.edge_status).toMatchObject({
      image: "traefik:v3.8.0",
      kind: "started",
    });
    // Free again once it is done.
    await expect(applyEdgeConfig({ up })).resolves.toBeTruthy();
  });
});
