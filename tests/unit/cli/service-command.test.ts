/**
 * `<cli> service install|status|print|uninstall`: the web UI's launchd
 * service, over Den's service/install.sh. The runner is injected, so nothing
 * here calls launchctl or bash.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as http from "http";
import type { AddressInfo } from "net";
import * as path from "path";
import {
  cmdService,
  waitForServerInfo,
  type ServiceRunner,
} from "../../../src/ui/cli/service-command.js";
import {
  readWebServiceConfig,
  type DenConfig,
} from "../../../src/shared/den-config.js";
import { ForeignServerError } from "../../../src/ui/cli/server-identity.js";

const DIST = "/src/acme-dev";
const HOME = "/home/someone";

const config = (web?: unknown): DenConfig =>
  ({ environments: ["local"], ...(web ? { web } : {}) }) as DenConfig;

describe("readWebServiceConfig", () => {
  it("defaults to what service/install.sh defaults to (the dist dir name)", () => {
    expect(readWebServiceConfig(config(), DIST, HOME)).toEqual({
      label: "local.acme-dev.web",
      logs: "/home/someone/Library/Logs/acme-dev",
    });
  });

  it("reads web.service.label and web.service.logs (~ expanded)", () => {
    expect(
      readWebServiceConfig(
        config({ port: 7001, service: { label: "com.acme.den", logs: "~/x" } }),
        DIST,
        HOME,
      ),
    ).toEqual({ label: "com.acme.den", logs: "/home/someone/x" });
  });

  it("resolves a relative logs dir under the distribution root", () => {
    expect(
      readWebServiceConfig(config({ service: { logs: "logs" } }), DIST, HOME)
        .logs,
    ).toBe(path.join(DIST, "logs"));
  });

  it("rejects a bad label, a non-string logs and unknown keys", () => {
    expect(() =>
      readWebServiceConfig(config({ service: { label: "a b/c" } }), DIST, HOME),
    ).toThrow(/web\.service\.label/);
    expect(() =>
      readWebServiceConfig(config({ service: { logs: 3 } }), DIST, HOME),
    ).toThrow(/web\.service\.logs/);
    expect(() =>
      readWebServiceConfig(config({ service: { lable: "x" } }), DIST, HOME),
    ).toThrow(/web\.service: unknown key "lable"/);
    expect(() =>
      readWebServiceConfig(config({ service: "x" }), DIST, HOME),
    ).toThrow(/web\.service must be a map/);
  });
});

function harness(
  over: {
    platform?: NodeJS.Platform;
    code?: number;
    web?: unknown;
    ready?: boolean;
    /** The poller finds another distribution's server: who it is. */
    foreign?: string;
  } = {},
) {
  const polls: { url: string; timeoutMs: number }[] = [];
  const calls: { cmd: string; args: string[]; env: Record<string, string> }[] =
    [];
  const run: ServiceRunner = (cmd, args, env) => {
    calls.push({ cmd, args, env });
    return over.code ?? 0;
  };
  const lines: string[] = [];
  const deps = {
    run,
    config: config(over.web),
    distRoot: DIST,
    home: HOME,
    engineRoot: "/src/acme-dev/node_modules/@monster-orange/den",
    platform: over.platform ?? ("darwin" as NodeJS.Platform),
    log: (l: string) => lines.push(l),
    webPort: 7001,
    waitReady: async (url: string, timeoutMs: number) => {
      polls.push({ url, timeoutMs });
      if (over.foreign) throw new ForeignServerError(7001, over.foreign);
      return over.ready ?? true;
    },
  };
  return { deps, calls, lines, polls };
}

describe("cmdService", () => {
  it.each(["install", "status", "print", "uninstall"])(
    "%s runs service/install.sh with the distribution and the label",
    async (sub) => {
      const h = harness({
        web: { service: { label: "com.acme.den", logs: "/var/log/acme" } },
      });
      expect(await cmdService([sub], h.deps)).toBe(0);
      expect(h.calls).toEqual([
        {
          cmd: "bash",
          args: [
            "/src/acme-dev/node_modules/@monster-orange/den/service/install.sh",
            sub,
          ],
          env: {
            DEN_ROOT: DIST,
            DEN_SERVICE_LABEL: "com.acme.den",
            DEN_SERVICE_LOGS: "/var/log/acme",
            // install: the CLI, not the script, says when it is running.
            ...(sub === "install"
              ? { DEN_SERVICE_READY_CHECK: "external" }
              : {}),
          },
        },
      ]);
    },
  );

  it("passes the script's own defaults when the config sets nothing", async () => {
    const h = harness();
    await cmdService(["print"], h.deps);
    expect(h.calls[0].env).toEqual({
      DEN_ROOT: DIST,
      DEN_SERVICE_LABEL: "local.acme-dev.web",
      DEN_SERVICE_LOGS: "/home/someone/Library/Logs/acme-dev",
    });
  });

  it("returns the script's exit code, and polls nothing when it failed", async () => {
    const h = harness({ code: 1 });
    expect(await cmdService(["install"], h.deps)).toBe(1);
    expect(h.polls).toEqual([]);
  });

  it("install says running only once /api/server-info answers", async () => {
    const h = harness({ web: { service: { logs: "/var/log/acme" } } });
    expect(await cmdService(["install"], h.deps)).toBe(0);
    expect(h.polls).toEqual([
      { url: "http://localhost:7001/api/server-info", timeoutMs: 30_000 },
    ]);
    expect(h.lines.join("\n")).toMatch(
      /local\.acme-dev\.web running .*http:\/\/localhost:7001/,
    );
  });

  it("install that never answers: exit 1, pointing at the logs", async () => {
    const h = harness({
      ready: false,
      web: { service: { logs: "/var/log/acme" } },
    });
    expect(await cmdService(["install"], h.deps)).toBe(1);
    expect(h.lines.join("\n")).toMatch(
      /installed but not answering yet: check \/var\/log\/acme/,
    );
    expect(h.lines.join("\n")).not.toMatch(/ running/);
  });

  it("install that finds another distribution's server on the port: exit 1, never 'running'", async () => {
    const h = harness({ foreign: "acme-ops at /srv/acme-other" });
    expect(await cmdService(["install"], h.deps)).toBe(1);
    const out = h.lines.join("\n");
    expect(out).toMatch(
      /installed, but port 7001 is in use by acme-ops at \/srv\/acme-other/,
    );
    expect(out).toMatch(/pick another port/);
    expect(out).not.toMatch(/ running at/);
  });

  it.each(["status", "print", "uninstall"])("%s polls nothing", async (sub) => {
    const h = harness();
    await cmdService([sub], h.deps);
    expect(h.polls).toEqual([]);
  });

  it("refuses an unknown subcommand, and no subcommand, without running anything", async () => {
    const h = harness();
    await expect(cmdService(["start"], h.deps)).rejects.toThrow(
      /install \| status \| print \| uninstall/,
    );
    await expect(cmdService([], h.deps)).rejects.toThrow(
      /install \| status \| print \| uninstall/,
    );
    expect(h.calls).toEqual([]);
  });

  it("is macOS only, except print", async () => {
    const h = harness({ platform: "linux" });
    await expect(cmdService(["install"], h.deps)).rejects.toThrow(/macOS/);
    expect(h.calls).toEqual([]);
    expect(await cmdService(["print"], h.deps)).toBe(0);
    expect(h.calls).toHaveLength(1);
  });
});

describe("waitForServerInfo", () => {
  let server: http.Server | undefined;
  afterEach(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = undefined;
  });

  const OWN = { root: DIST, product: "den" };

  /** A web server that answers with an empty body `empty` times first. */
  async function stub(
    empty: number,
    root: string = DIST,
    prod = "den",
  ): Promise<string> {
    let n = 0;
    server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        n++ < empty
          ? ""
          : JSON.stringify({ pid: 1, version: "0.0.0", root, product: prod }),
      );
    });
    await new Promise<void>((r) => server!.listen(0, "localhost", r));
    return `http://localhost:${(server.address() as AddressInfo).port}/api/server-info`;
  }

  it("waits through empty bodies until valid JSON", async () => {
    const url = await stub(2);
    expect(await waitForServerInfo(url, 5_000, 20, OWN)).toBe(true);
  });

  it("gives up after the timeout", async () => {
    const url = await stub(Infinity);
    expect(await waitForServerInfo(url, 300, 20, OWN)).toBe(false);
  });

  it("another distribution's server answering is never 'running'", async () => {
    const url = await stub(0, "/srv/acme-other", "acme-ops");
    await expect(waitForServerInfo(url, 2_000, 20, OWN)).rejects.toThrow(
      /port \d+ is in use by acme-ops at \/srv\/acme-other/,
    );
  });
});
