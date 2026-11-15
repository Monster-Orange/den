/**
 * 0.4.48: Den on the Docker bridge for the edge, on Linux (bridge-listen.ts).
 * The probe's runner is injected: nothing here runs docker.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  bridgeGateway,
  bridgeLine,
  bridgeWanted,
  readBridgeState,
  writeBridgeState,
  type Run,
} from "../../../src/shared/edge/bridge-listen.js";
import { bridgeListenLines } from "../../../src/ui/cli/doctor-command.js";
import { readWebAuthConfig } from "../../../src/shared/web-session.js";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-bridge-"));
  tmps.push(d);
  return d;
};

const base = {
  platform: "linux" as NodeJS.Platform,
  setting: "auto" as const,
  bindHost: undefined,
  edgeHere: true,
};

describe("whether Den looks for the bridge", () => {
  it("Linux, an edge here, auto, no DEN_BIND_HOST: it looks", () => {
    expect(bridgeWanted(base)).toBeNull();
  });

  it("macOS, or no edge: no, and nothing to say", () => {
    expect(bridgeWanted({ ...base, platform: "darwin" })).toMatchObject({
      quiet: true,
    });
    expect(bridgeWanted({ ...base, edgeHere: false })).toMatchObject({
      quiet: true,
    });
  });

  it("off, or DEN_BIND_HOST set: no, and says why", () => {
    expect(bridgeWanted({ ...base, setting: "off" })).toEqual({
      why: "web.bridge_listen is off",
      quiet: false,
    });
    expect(bridgeWanted({ ...base, bindHost: "172.17.0.1" })).toEqual({
      why: "DEN_BIND_HOST is set (172.17.0.1): only that address",
      quiet: false,
    });
    // Blank is unset.
    expect(bridgeWanted({ ...base, bindHost: " " })).toBeNull();
  });
});

describe("the bridge's gateway", () => {
  const fails =
    (e: Record<string, unknown>): Run =>
    () =>
      Promise.reject(Object.assign(new Error("x"), e));

  it("the address docker names, when it is a bridge address", async () => {
    const seen: string[][] = [];
    const run: Run = (cmd, args) => {
      seen.push([cmd, ...args]);
      return Promise.resolve("172.17.0.1 \n");
    };
    expect(await bridgeGateway(run)).toEqual({ address: "172.17.0.1" });
    expect(seen[0]?.slice(0, 4)).toEqual([
      "docker",
      "network",
      "inspect",
      "bridge",
    ]);
  });

  it("no docker CLI, a daemon that's down or slow: why, in words", async () => {
    expect(await bridgeGateway(fails({ code: "ENOENT" }))).toEqual({
      why: "no docker CLI on PATH",
    });
    expect(await bridgeGateway(fails({ code: 1 }))).toEqual({
      why: "the Docker daemon isn't answering",
    });
    expect(
      await bridgeGateway(fails({ killed: true, signal: "SIGTERM" }), 4000),
    ).toEqual({ why: "the Docker daemon didn't answer within 4 s" });
  });

  it("an address outside 172.16.0.0/12, or none: why", async () => {
    expect(await bridgeGateway(() => Promise.resolve("10.0.0.1"))).toEqual({
      why: "the bridge's gateway (10.0.0.1) isn't a Docker bridge address (172.16.0.0/12)",
    });
    expect(await bridgeGateway(() => Promise.resolve(" \n"))).toEqual({
      why: "the Docker bridge has no gateway address",
    });
  });
});

describe("what it says", () => {
  it("listening, plain HTTP with tls: none", () => {
    expect(
      bridgeLine(
        { state: "listening", address: "172.17.0.1", plainHttp: true },
        "Acme",
      ),
    ).toBe(
      "Listening on the Docker bridge (172.17.0.1) for the edge; plain HTTP because tls: none",
    );
    expect(
      bridgeLine(
        { state: "listening", address: "172.17.0.1", plainHttp: false },
        "Acme",
      ),
    ).toBe("Listening on the Docker bridge (172.17.0.1) for the edge");
  });

  it("doctor: what the running Den recorded, or nothing", () => {
    const dir = tmp();
    expect(bridgeListenLines("Acme", () => readBridgeState(dir)).lines).toEqual(
      [],
    );
    writeBridgeState(dir, { state: "skipped", why: "no docker CLI on PATH" });
    const d = bridgeListenLines("Acme", () => readBridgeState(dir));
    expect(d.check).toMatchObject({ id: "bridge_listen", status: "warn" });
    expect(d.lines.join("\n")).toContain(
      "Not on the Docker bridge: no docker CLI on PATH. The edge reaches Acme only if it can reach 127.0.0.1.",
    );
    writeBridgeState(dir, {
      state: "listening",
      address: "172.18.0.1",
      plainHttp: false,
    });
    expect(bridgeListenLines("Acme", () => readBridgeState(dir)).check).toEqual(
      {
        id: "bridge_listen",
        status: "ok",
        detail: "Listening on the Docker bridge (172.18.0.1) for the edge",
      },
    );
  });
});

describe("web.bridge_listen and web.bridge_probe_seconds", () => {
  const root = (user: string, team = "") => {
    const r = tmp();
    fs.mkdirSync(path.join(r, "config", "local"), { recursive: true });
    fs.writeFileSync(path.join(r, "config", "den.yml"), team);
    fs.writeFileSync(path.join(r, "config", "local", "user.yml"), user);
    return r;
  };

  it("default auto and 10 s; user.yml over the distribution's", () => {
    expect(readWebAuthConfig(root(""))).toMatchObject({
      bridgeListen: "auto",
      bridgeProbeSeconds: 10,
    });
    expect(
      readWebAuthConfig(
        root(
          "web:\n  bridge_listen: off\n",
          "web:\n  bridge_listen: auto\n  bridge_probe_seconds: 30\n",
        ),
      ),
    ).toMatchObject({ bridgeListen: "off", bridgeProbeSeconds: 30 });
  });

  it("a wrong value names the key", () => {
    expect(() =>
      readWebAuthConfig(root("web:\n  bridge_listen: yes\n")),
    ).toThrow("web.bridge_listen must be auto or off");
    expect(() =>
      readWebAuthConfig(root("web:\n  bridge_probe_seconds: 0\n")),
    ).toThrow("web.bridge_probe_seconds must be a number of seconds above 0");
  });
});
