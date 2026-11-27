import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const ENGINE = path.resolve(__dirname, "../../..");
let tmp = "";
let root = "";
let shim = "";
let log = "";
let box = "";
let edgeDir = "";

function write(file: string, content: string, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, mode ? { mode } : undefined);
}

function den(args: string[]) {
  const r = spawnSync(path.join(ENGINE, "bin", "den"), args, {
    cwd: root,
    encoding: "utf-8",
    env: {
      ...process.env,
      DEN_ROOT: root,
      DEN_HOME: path.join(tmp, "home"),
      DEN_EDGE_DIR: edgeDir,
      DEN_DAEMONS_FILE: path.join(tmp, "daemons.json"),
      PATH: `${shim}:${process.env.PATH ?? ""}`,
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    },
    timeout: 60_000,
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function running(cmd: string[]): string {
  return JSON.stringify([
    {
      Id: "c0ffee",
      Image: "sha256:edge",
      State: { Status: "running", StartedAt: "2026-11-25T10:00:00Z" },
      Config: { Image: "traefik", Cmd: cmd },
      HostConfig: {},
      Mounts: [],
      NetworkSettings: { Networks: {} },
    },
  ]);
}

const calls = (): string[] =>
  fs.readFileSync(log, "utf-8").split("\n").filter(Boolean);

function upTo(cs: string[]): string[] {
  const end = cs.findIndex((c) => / compose -f .* up /.test(` ${c} `));
  expect(end).toBeGreaterThan(-1);
  return cs
    .slice(0, end + 1)
    .filter((c) =>
      /^inspect --type container acme-edge$|^stop |compose -f /.test(c),
    )
    .map((c) =>
      c.startsWith("inspect")
        ? "inspect"
        : c.startsWith("stop")
          ? "stop"
          : "up",
    );
}

beforeAll(() => {
  tmp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "den-edge-one-")),
  );
  root = path.join(tmp, "den");
  edgeDir = path.join(tmp, "edge");
  shim = path.join(tmp, "shim");
  log = path.join(tmp, "docker.log");
  box = path.join(tmp, "container.json");
  write(path.join(root, "den.yml"), "product:\n  name: den\n");
  write(
    path.join(root, "config", "den.yml"),
    [
      "environments: [local]",
      "edge:",
      "  org: acme",
      "  domain: acme.localhost",
      "  publish: false",
      "  tls: none",
      "",
    ].join("\n"),
  );
  write(
    path.join(shim, "docker"),
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> '${log}'`,
      'case " $* " in',
      `  *' inspect --type container acme-edge '*) cat '${box}' ;;`,
      "  *' inspect -f '*) echo true ;;",
      `  *' stop acme-edge '*) sed 's/"running"/"exited"/' '${box}' > '${box}.t' && mv '${box}.t' '${box}' ;;`,
      "esac",
      "exit 0",
      "",
    ].join("\n"),
    0o755,
  );
});

beforeEach(() => write(log, ""));

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("edge up inspects the edge once before compose up", () => {
  it("a running edge without the API: one inspect, then up", () => {
    write(box, running(["--providers.file.directory=/etc/edge/dynamic"]));
    const r = den(["edge", "up"]);
    expect(r.code).toBe(0);
    expect(upTo(calls())).toEqual(["inspect", "up"]);
  }, 60_000);

  it("a running edge with the API on: inspect, stop, inspect again, then up", () => {
    write(
      box,
      running([
        "--providers.file.directory=/etc/edge/dynamic",
        "--api.insecure=true",
      ]),
    );
    const r = den(["edge", "up"]);
    expect(r.code).toBe(0);
    expect(upTo(calls())).toEqual(["inspect", "stop", "inspect", "up"]);
  }, 60_000);
});
