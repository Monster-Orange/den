/**
 * #63: the edge's access log, masked by Den. One-time tokens never reach
 * edge-access.log; the raw file is emptied each sweep; doctor and edge
 * status say when sweeps have stopped; startup sweeps what was left.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  maskAccessLine,
  maskRequestPath,
  readAccessLogConfig,
  requestIdOf,
} from "../../../src/shared/edge/access-log.js";
import {
  accessPaths,
  edgeAccessHealthy,
  edgeAccessWarnings,
  prepareAccessRaw,
  rawAccessWarning,
  sweepAccessLog,
} from "../../../src/shared/edge/access-sweep.js";
import {
  accessLogArgs,
  renderEdgeCompose,
  traefikMajor,
} from "../../../src/shared/edge/render.js";
import { edgeUpNotices } from "../../../src/shared/edge/runtime.js";
import type { EdgeConfig } from "../../../src/shared/edge/types.js";

const SECRET = "s3cr3t-0ne-t1me";
const on = readAccessLogConfig(true);

/** A line as Traefik writes it (the fields Den reads). */
function traefikLine(p: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    StartUTC: "2026-11-13T12:00:00Z",
    RequestMethod: "GET",
    RequestHost: "app.acme.localhost",
    RequestPath: p,
    RequestProtocol: "HTTP/1.1",
    DownstreamStatus: 200,
    OriginStatus: 200,
    Duration: 1000,
    RouterName: "app@file",
    ServiceName: "app@file",
    ClientHost: "172.17.0.1",
    TraceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    request_Authorization: "Bearer nope",
    ...extra,
  });
}

describe("edge.access_log config", () => {
  it("is off unless set, and lists add to the defaults", () => {
    expect(readAccessLogConfig(undefined).enabled).toBe(false);
    expect(readAccessLogConfig(false).enabled).toBe(false);
    const c = readAccessLogConfig({
      mask_query: ["Invite", "token"],
      mask_paths: ["/invite/*"],
      max_mb: 5,
    });
    expect(c).toEqual({
      enabled: true,
      maskQuery: [
        "token",
        "code",
        "key",
        "secret",
        "password",
        "state",
        "invite",
      ],
      maskPaths: ["/auth/link/*", "/invite/*"],
      maxMb: 5,
    });
  });
  it("names the key on a bad value", () => {
    expect(() => readAccessLogConfig({ mask_paths: ["/invite"] })).toThrow(
      /mask_paths/,
    );
    expect(() => readAccessLogConfig({ max_mb: 0 })).toThrow(/max_mb/);
    expect(() => readAccessLogConfig({ nope: 1 })).toThrow(
      /unknown key "nope"/,
    );
    expect(() => readAccessLogConfig("yes")).toThrow(/edge.access_log/);
  });
});

describe("masking", () => {
  it("masks the default query keys and /auth/link/*, keeps the rest", () => {
    expect(
      maskRequestPath(
        `/cb?code=${SECRET}&state=${SECRET}&page=ok&Token=${SECRET}`,
        on,
      ),
    ).toBe("/cb?code=[redacted]&state=[redacted]&page=ok&Token=[redacted]");
    expect(maskRequestPath(`/auth/link/${SECRET}/go`, on)).toBe(
      "/auth/link/[redacted]",
    );
    expect(maskRequestPath("/auth/link/", on)).toBe("/auth/link/");
    expect(maskRequestPath("/api/x?page=2", on)).toBe("/api/x?page=2");
    // An escaped key is still the key.
    expect(maskRequestPath(`/x?%74oken=${SECRET}`, on)).toBe(
      "/x?%74oken=[redacted]",
    );
  });
  it("masks configured additions", () => {
    const c = readAccessLogConfig({
      mask_query: ["invite"],
      mask_paths: ["/i/*"],
    });
    expect(maskRequestPath(`/i/${SECRET}?invite=${SECRET}`, c)).toBe(
      "/i/[redacted]?invite=[redacted]",
    );
  });
  it("keeps only the known fields (never headers), with the request id", () => {
    const out = JSON.parse(
      maskAccessLine(traefikLine(`/cb?token=${SECRET}`), on)!,
    ) as Record<string, unknown>;
    expect(out.RequestPath).toBe("/cb?token=[redacted]");
    expect(out.request_id).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(out).not.toHaveProperty("request_Authorization");
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });
  it("says why for a 502 the edge made itself", () => {
    const out = JSON.parse(
      maskAccessLine(
        traefikLine("/mcp", {
          DownstreamStatus: 502,
          OriginStatus: 0,
          OriginContentSize: 0,
        }),
        on,
      )!,
    ) as Record<string, unknown>;
    expect(out.why).toMatch(/no answer from the service/);
    expect(maskAccessLine("not json", on)).toBeNull();
    expect(maskAccessLine('{"level":"info"}', on)).toBeNull();
  });
  it("reads the request id from traceparent", () => {
    expect(
      requestIdOf("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"),
    ).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(requestIdOf(`00-${"0".repeat(32)}-00f067aa0ba902b7-01`)).toBeNull();
    expect(requestIdOf("junk")).toBeNull();
  });
});

describe("render", () => {
  const cfg = {
    org: "acme",
    domain: "acme.localhost",
    aliases: [],
    image: "traefik:v3.7",
    workspaces: [],
    routes: {},
    ports: null,
    stateDir: "/tmp/acme/edge",
    tls: { strategy: "none" },
    tlsFrom: "explicit",
    httpsRedirect: false,
    dockerLabels: null,
    include: null,
    mounts: {},
    networks: [],
    args: [],
  } as unknown as EdgeConfig;
  it("adds nothing when off", () => {
    expect(accessLogArgs(cfg)).toEqual([]);
    expect(renderEdgeCompose(cfg)).not.toContain("/var/log/edge");
  });
  it("writes JSON to the raw file Den sweeps, with trace ids, when on", () => {
    const c = { ...cfg, accessLog: on };
    expect(accessLogArgs(c)).toEqual(
      expect.arrayContaining([
        "--accesslog=true",
        "--accesslog.format=json",
        "--accesslog.filepath=/var/log/edge/access.json",
        "--tracing=true",
      ]),
    );
    expect(renderEdgeCompose(c)).toContain("./access:/var/log/edge");
  });
});

describe("only flags the edge's Traefik understands (#330)", () => {
  const base = {
    org: "acme",
    domain: "acme.localhost",
    aliases: [],
    image: "traefik:v3.7.17",
    workspaces: [],
    routes: {},
    ports: null,
    stateDir: "/tmp/acme/edge",
    tls: { strategy: "none" },
    tlsFrom: "explicit",
    httpsRedirect: false,
    dockerLabels: null,
    include: null,
    mounts: {},
    networks: [],
    args: [],
    accessLog: on,
  } as unknown as EdgeConfig;
  const withImage = (image: string) => ({ ...base, image });
  const tracing = (image: string) =>
    accessLogArgs(withImage(image)).filter((a) => a.startsWith("--tracing"));
  const ACCESS = [
    "--accesslog=true",
    "--accesslog.format=json",
    "--accesslog.filepath=/var/log/edge/access.json",
    "--accesslog.bufferingsize=0",
  ];

  it("a Traefik v2 edge gets the access log without tracing, which v2 rejects", () => {
    expect(accessLogArgs(withImage("traefik:v2.11"))).toEqual(ACCESS);
    expect(tracing("traefik:v2.11.3")).toEqual([]);
    expect(tracing("traefik:2.11")).toEqual([]);
  });

  it("a Traefik v3 edge gets the trace ids", () => {
    for (const image of [
      "traefik:v3.7.17",
      "traefik:3.7",
      "docker.io/library/traefik:v3.7.17",
      `traefik:v3.7@sha256:${"a".repeat(64)}`,
      "traefik:v4.0",
    ])
      expect(tracing(image)).toEqual([
        "--tracing=true",
        "--tracing.otlp=true",
        "--tracing.otlp.http.endpoint=http://127.0.0.1:1/v1/traces",
      ]);
  });

  it("a tag Den can't read a version from never gets a flag that could stop the edge", () => {
    for (const image of [
      "traefik:latest",
      "traefik",
      `traefik@sha256:${"a".repeat(64)}`,
      "registry.local:5000/edge-proxy:v3.7",
      "traefik:nightly",
    ]) {
      expect(accessLogArgs(withImage(image))).toEqual(ACCESS);
    }
  });

  it("reads the major version from the image's tag", () => {
    expect(traefikMajor("traefik:v2.11")).toBe(2);
    expect(traefikMajor("traefik:v2.11.3")).toBe(2);
    expect(traefikMajor("traefik:2.11")).toBe(2);
    expect(traefikMajor("docker.io/library/traefik:v3.7.17")).toBe(3);
    expect(traefikMajor("localhost:5000/traefik:v3.1")).toBe(3);
    expect(traefikMajor(`traefik:v3.7@sha256:${"b".repeat(64)}`)).toBe(3);
    expect(traefikMajor("traefik:v3.7-alpine")).toBe(3);
    expect(traefikMajor("traefik:latest")).toBeNull();
    expect(traefikMajor("traefik")).toBeNull();
    expect(traefikMajor(`traefik@sha256:${"b".repeat(64)}`)).toBeNull();
    expect(traefikMajor("acme/edge:v3.7")).toBeNull();
  });

  it("edge up says when the access log is on without request ids", () => {
    expect(edgeUpNotices(withImage("traefik:v2.11"), null)).toEqual([
      "Access log on without request ids: traefik:v2.11 is older than Traefik v3.",
    ]);
    expect(edgeUpNotices(withImage("traefik:latest"), null)).toEqual([
      "Access log on without request ids: Den can't tell which Traefik version traefik:latest is.",
    ]);
    expect(edgeUpNotices(base, null)).toEqual([]);
    expect(
      edgeUpNotices(
        { ...withImage("traefik:v2.11"), accessLog: undefined },
        null,
      ),
    ).toEqual([]);
  });
});

describe("the sweep", () => {
  let dir = "";
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-access-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const raw = () => accessPaths(dir).raw;
  const kept = () => fs.readFileSync(accessPaths(dir).log, "utf-8");

  it("makes the raw file 0600 in a 0700 dir", () => {
    prepareAccessRaw(dir);
    expect(fs.statSync(accessPaths(dir).dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(raw()).mode & 0o777).toBe(0o600);
  });

  it("masks into edge-access.log (0600) and empties the raw file", () => {
    prepareAccessRaw(dir);
    fs.appendFileSync(
      raw(),
      [
        traefikLine(`/cb?token=${SECRET}`),
        "garbage " + SECRET,
        traefikLine(`/auth/link/${SECRET}`),
        "",
      ].join("\n") + '{"RequestPath":"/part',
    );
    // Traefik is mid-line: nothing is taken until the line is whole.
    expect(sweepAccessLog(dir, on)).toEqual({ kept: 0, dropped: 0 });
    fs.appendFileSync(raw(), '"}\n');
    expect(sweepAccessLog(dir, on)).toEqual({ kept: 3, dropped: 1 });
    expect(kept()).not.toContain(SECRET);
    expect(kept().trim().split("\n")).toHaveLength(3);
    expect(fs.statSync(accessPaths(dir).log).mode & 0o777).toBe(0o600);
    expect(fs.statSync(raw()).size).toBe(0);
  });

  it("rotates past max_mb, keeping one .1", () => {
    prepareAccessRaw(dir);
    fs.writeFileSync(accessPaths(dir).log, "x".repeat(1024 * 1024));
    fs.appendFileSync(raw(), traefikLine("/a") + "\n");
    sweepAccessLog(dir, { ...on, maxMb: 1 });
    expect(fs.statSync(`${accessPaths(dir).log}.1`).size).toBe(1024 * 1024);
    expect(kept().trim().split("\n")).toHaveLength(1);
  });

  it("with the reader stopped, warns; started again, masks and empties first", () => {
    prepareAccessRaw(dir);
    // Den's server is down: the edge keeps appending, nothing sweeps.
    for (let i = 0; i < 80; i++)
      fs.appendFileSync(raw(), traefikLine(`/cb?code=${SECRET}${i}`) + "\n");
    const now = Date.now();
    expect(fs.statSync(raw()).size).toBeGreaterThan(16 * 1024);
    expect(rawAccessWarning(dir, now)).toMatch(/unmasked.*nothing is masking/);
    // Small but old: also a warning.
    const small = fs.mkdtempSync(path.join(os.tmpdir(), "den-access-"));
    try {
      prepareAccessRaw(small);
      fs.appendFileSync(accessPaths(small).raw, traefikLine("/a") + "\n");
      expect(rawAccessWarning(small, now)).toBeNull();
      expect(rawAccessWarning(small, now + 11_000)).toMatch(/s ago/);
    } finally {
      fs.rmSync(small, { recursive: true, force: true });
    }
    expect(edgeAccessWarnings({ args: [], stateDir: dir }, now)).toHaveLength(
      1,
    );
    // #63: doctor's healthy line only when nothing is wrong.
    const cfg = { args: [], stateDir: dir, accessLog: { enabled: true } };
    expect(edgeAccessHealthy(cfg, now)).toBeNull();
    // The server starts: its first act is a sweep.
    expect(sweepAccessLog(dir, on).kept).toBe(80);
    expect(fs.statSync(raw()).size).toBe(0);
    expect(kept()).not.toContain(SECRET);
    expect(rawAccessWarning(dir, now + 60_000)).toBeNull();
    expect(edgeAccessHealthy(cfg, now + 60_000)).toBe(
      `access log on: masked into ${accessPaths(dir).log}, and kept up with`,
    );
    expect(
      edgeAccessHealthy({ ...cfg, accessLog: { enabled: false } }, now),
    ).toBeNull();
  });

  it("warns on an edge.args --accesslog, and not otherwise", () => {
    expect(
      edgeAccessWarnings({ args: ["--accesslog=true"], stateDir: dir }),
    ).toEqual([expect.stringMatching(/edge\.args sets --accesslog/)]);
    expect(
      edgeAccessWarnings({ args: ["--accesslog.format=json"], stateDir: dir }),
    ).toHaveLength(1);
    expect(
      edgeAccessWarnings({ args: ["--log.level=INFO"], stateDir: dir }),
    ).toEqual([]);
  });

  it("reads past the NUL hole a Docker VM share leaves after an empty", () => {
    prepareAccessRaw(dir);
    const first = traefikLine(`/a?token=${SECRET}`) + "\n";
    fs.appendFileSync(raw(), first);
    expect(sweepAccessLog(dir, on).kept).toBe(1);
    // Traefik writes on at its own offset: a hole, then the new line.
    const fd = fs.openSync(raw(), "r+");
    fs.writeSync(fd, traefikLine(`/b?token=${SECRET}`) + "\n", first.length);
    fs.closeSync(fd);
    expect(rawAccessWarning(dir)).toBeNull();
    expect(sweepAccessLog(dir, on)).toEqual({ kept: 1, dropped: 0 });
    expect(kept()).toContain('"/b?token=[redacted]"');
    expect(kept()).not.toContain(SECRET);
  });

  it("is a no-op with no raw file", () => {
    expect(sweepAccessLog(dir, on)).toEqual({ kept: 0, dropped: 0 });
    expect(rawAccessWarning(dir)).toBeNull();
  });
});
