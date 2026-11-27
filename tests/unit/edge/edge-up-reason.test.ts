/**
 * #385 / issue 395: why `edge up` recreated the edge. The running
 * container's spec (as `docker inspect` gives it) against the one Den
 * renders: image (a tag, a digest, or the id a tag now resolves to), each
 * command flag, each port, each mount, the networks. The answer is one
 * line, the CLI's and the page's: started, up to date, or recreated
 * because <field>: <old> → <new>, unreachable for about N s.
 * Pure: no Docker.
 */
import { describe, expect, it } from "@jest/globals";
import * as yaml from "yaml";
import {
  edgeCommand,
  renderEdgeCompose,
} from "../../../src/shared/edge/render.js";
import {
  edgeSpecChanges,
  edgeUpLine,
  edgeUpOutcome,
  parseEdgeInspect,
  renderedEdgeSpec,
  type RunningEdge,
} from "../../../src/shared/edge/spec.js";
import type { EdgeConfig } from "../../../src/shared/edge/types.js";

const ROOT = "/tmp/acme-edge";
const edge: EdgeConfig = {
  org: "acme",
  domain: "acme.localhost",
  aliases: [],
  image: "traefik:v3.7.17",
  workspaces: ["main"],
  routes: {},
  ports: { http: 7080, https: 7443 },
  stateDir: ROOT,
  tls: { strategy: "mkcert", ca: null },
  tlsFrom: "explicit",
  httpsRedirect: true,
  dockerLabels: null,
  include: null,
  mounts: { "/srv/acme/static": "/etc/edge/static" },
  networks: ["acme-apps"],
  args: [],
};
const DIGEST = "sha256:" + "ab".repeat(32);
const ID_A = "sha256:" + "1".repeat(64);
const ID_B = "sha256:" + "2".repeat(64);

/** `docker inspect` of an edge running `cfg` as rendered, with overrides. */
function inspectJson(
  cfg: EdgeConfig,
  over: {
    image?: string;
    imageId?: string;
    cmd?: string[];
    ports?: Record<string, string>;
    id?: string;
    startedAt?: string;
    status?: string;
  } = {},
): string {
  const s = renderedEdgeSpec(cfg, ROOT);
  const ports = over.ports ?? s.ports;
  return JSON.stringify([
    {
      Id: over.id ?? "c1",
      Image: over.imageId ?? ID_A,
      State: {
        Status: over.status ?? "running",
        StartedAt: over.startedAt ?? "2026-11-17T10:00:00.000Z",
      },
      Config: { Image: over.image ?? cfg.image, Cmd: over.cmd ?? s.command },
      HostConfig: {
        PortBindings: Object.fromEntries(
          Object.entries(ports).map(([c, h]) => [
            `${c}/tcp`,
            [{ HostIp: "", HostPort: h }],
          ]),
        ),
      },
      Mounts: Object.entries(s.mounts).map(([dst, src]) => ({
        Source: src,
        Destination: dst,
      })),
      NetworkSettings: {
        Networks: Object.fromEntries(s.networks.map((n) => [n, {}])),
      },
    },
  ]);
}
const running = (cfg: EdgeConfig, over = {}) =>
  parseEdgeInspect(inspectJson(cfg, over))!;
const changes = (r: RunningEdge, cfg: EdgeConfig, imageId = ID_A) =>
  edgeSpecChanges(r.spec, renderedEdgeSpec(cfg, ROOT, imageId));

describe("the edge's own spec, as Den renders it", () => {
  it("is compose.yml's edge service: image, command, ports, mounts, networks", () => {
    const svc = yaml.parse(renderEdgeCompose(edge, ROOT)).services.edge;
    const s = renderedEdgeSpec(edge, ROOT);
    expect(s.image).toBe(svc.image);
    expect(s.command).toEqual(svc.command);
    expect(Object.entries(s.ports).map(([c, h]) => `${h}:${c}`)).toEqual(
      svc.ports,
    );
    expect(
      Object.entries(s.mounts)
        .map(([dst, src]) => `${src.replace(ROOT, ".")}:${dst}:ro`)
        .sort(),
    ).toEqual([...svc.volumes].sort());
    expect(s.networks).toEqual([...svc.networks].sort());
  });
});

describe("#385: why the edge is recreated", () => {
  it("no change: nothing to say", () => {
    expect(changes(running(edge), edge)).toEqual([]);
  });

  it("an image tag", () => {
    expect(changes(running(edge, { image: "traefik:v3.6.0" }), edge)).toEqual([
      { field: "image", old: "traefik:v3.6.0", new: "traefik:v3.7.17" },
    ]);
  });

  it("a tag to a digest (the bed's case), shortened to read", () => {
    const cfg = { ...edge, image: `traefik@${DIGEST}` };
    expect(changes(running(edge), cfg)).toEqual([
      {
        field: "image",
        old: "traefik:v3.7.17",
        new: `traefik@sha256:${"ab".repeat(6)}`,
      },
    ]);
  });

  it("the same tag, now another image here", () => {
    expect(changes(running(edge), edge, ID_B)).toEqual([
      {
        field: "image",
        old: `traefik:v3.7.17 (sha256:${"1".repeat(12)})`,
        new: `traefik:v3.7.17 (sha256:${"2".repeat(12)})`,
      },
    ]);
  });

  it("a command flag", () => {
    const cfg = { ...edge, args: ["--log.level=ERROR"] };
    const r = running(edge, {
      cmd: [...edgeCommand(edge), "--log.level=INFO"],
    });
    expect(changes(r, cfg)).toEqual([
      { field: "--log.level", old: "INFO", new: "ERROR" },
    ]);
  });

  it("a port", () => {
    const r = running(edge, { ports: { "80": "7080", "443": "8443" } });
    expect(changes(r, edge)).toEqual([
      { field: "port 443", old: "8443", new: "7443" },
    ]);
  });

  it("a mount and a network", () => {
    const cfg = {
      ...edge,
      mounts: {},
      networks: ["acme-apps", "acme-db"],
    };
    expect(changes(running(edge), cfg)).toEqual([
      { field: "mount /etc/edge/static", old: "/srv/acme/static", new: "none" },
      {
        field: "networks",
        old: "acme-apps, acme-edge",
        new: "acme-apps, acme-db, acme-edge",
      },
    ]);
  });

  it("a docker inspect that isn't one container: none", () => {
    expect(parseEdgeInspect("[]")).toBeNull();
    expect(parseEdgeInspect("not json")).toBeNull();
  });
});

describe("issue 395: what edge up did, in one line", () => {
  const t = { began: Date.parse("2026-11-17T11:00:00.000Z"), ended: 0 };
  t.ended = t.began + 30_000;

  it("none running before: started", () => {
    const o = edgeUpOutcome(null, running(edge), [], t);
    expect(o.kind).toBe("started");
    expect(edgeUpLine(o)).toBe("Edge started");
    const stopped = running(edge, { status: "exited" });
    expect(edgeUpOutcome(stopped, running(edge), [], t).kind).toBe("started");
  });

  it("the same container, not restarted: up to date", () => {
    const o = edgeUpOutcome(running(edge), running(edge), [], t);
    expect(edgeUpLine(o)).toBe("Edge up to date, nothing restarted");
  });

  it("a new container: recreated, why, and about how long it was down", () => {
    const before = running(edge, { image: "traefik:v3.6.0" });
    const after = running(edge, {
      id: "c2",
      startedAt: "2026-11-17T11:00:27.400Z",
    });
    const o = edgeUpOutcome(before, after, changes(before, edge), t);
    expect(o).toMatchObject({ kind: "recreated", downSeconds: 27 });
    expect(edgeUpLine(o)).toBe(
      "Edge recreated because image: traefik:v3.6.0 → traefik:v3.7.17; it was unreachable for about 27 s",
    );
  });

  it("recreated for a reason Den doesn't compare: says its settings changed", () => {
    const after = running(edge, { id: "c2", startedAt: "garbage" });
    const o = edgeUpOutcome(running(edge), after, [], t);
    expect(edgeUpLine(o)).toBe(
      "Edge recreated because its settings changed; it was unreachable for about 30 s",
    );
  });
});
