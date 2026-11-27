import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readEdgeConfig } from "../../../src/shared/edge/config.js";
import {
  droppedEdgeArgs,
  edgeCommand,
} from "../../../src/shared/edge/render.js";
import { edgeUpNotices } from "../../../src/shared/edge/runtime.js";
import type { EdgeConfig } from "../../../src/shared/edge/types.js";

const edge: EdgeConfig = {
  org: "acme",
  domain: "acme.localhost",
  aliases: [],
  image: "traefik:v3.7.17",
  workspaces: [],
  routes: { den: "http://host.docker.internal:7000" },
  ports: { http: 80, https: 443 },
  stateDir: "/tmp/x",
  tls: { strategy: "mkcert", ca: null },
  tlsFrom: "explicit",
  httpsRedirect: true,
  dockerLabels: null,
  include: null,
  mounts: {},
  networks: [],
  args: [],
};

const cmd = (args: string[]) => edgeCommand({ ...edge, args });

const REFUSED: [string[], string][] = [
  [["-api.insecure=true"], "api.insecure"],
  [["-api"], "api"],
  [["--api.dashboard=true"], "api.dashboard"],
  [["--API=true"], "api"],
  [["-configFile=/etc/edge/static.yml"], "configfile"],
  [["-configfile", "/etc/edge/static.yml"], "configfile"],
  [["--configFile=/x.toml"], "configfile"],
  [["TRAEFIK_API_INSECURE=true"], "TRAEFIK_API_INSECURE=true"],
  [["--TRAEFIK_API=true"], "traefik_api"],
  [["--log.level=DEBUG"], "log.level"],
  [["-log.level=trace"], "log.level"],
  [["--log.level", "DEBUG"], "log.level"],
  [
    ["--accesslog.fields.headers.defaultmode=keep"],
    "accesslog.fields.headers.defaultmode",
  ],
  [
    ["-accesslog.fields.headers.names.X-Den-Edge-Proof=keep"],
    "accesslog.fields.headers.names.x-den-edge-proof",
  ],
  [["--accesslog.filepath=/dev/stdout"], "accesslog.filepath"],
  [
    ["--providers.docker.endpoint=tcp://evil:2375"],
    "providers.docker.endpoint",
  ],
  [["-providers.file.directory=/tmp"], "providers.file.directory"],
  [["--entrypoints.evil.address=:8080"], "entrypoints.evil.address"],
  [["--entrypoints.web.address=:81"], "entrypoints.web.address"],
  [
    ["--experimental.plugins.x.modulename=example.com/x"],
    "experimental.plugins.x.modulename",
  ],
  [["--metrics.prometheus=true"], "metrics.prometheus"],
  [["--tracing.otlp.http.endpoint=http://x"], "tracing.otlp.http.endpoint"],
  [["/etc/edge/static.yml"], "/etc/edge/static.yml"],
  [["--"], "--"],
  [["-"], "-"],
];

describe("edge.args: an allow-list", () => {
  it.each(REFUSED)("refuses %j, naming %s", (args, key) => {
    expect(() => cmd(args)).toThrow(
      new RegExp(
        `^edge\\.args: .*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.* edge\\.args can't set`,
        "i",
      ),
    );
  });

  it("refuses the same at config read, with the same line", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "den-edge-args-"));
    try {
      fs.mkdirSync(path.join(root, "config"), { recursive: true });
      const write = (arg: string) =>
        fs.writeFileSync(
          path.join(root, "config", "den.yml"),
          [
            "edge:",
            "  org: acme",
            "  domain: acme.localhost",
            "  tls: none",
            "  args:",
            `    - "${arg}"`,
            "",
          ].join("\n"),
        );
      write("-api.insecure=true");
      expect(() => readEdgeConfig(root)).toThrow(
        /^edge\.args: "-api\.insecure=true" sets api\.insecure/,
      );
      write("--accesslog=true");
      expect(readEdgeConfig(root).args).toEqual(["--accesslog=true"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps what it may set, in either spelling and form", () => {
    const args = [
      "--accesslog=true",
      "-accesslog.format=json",
      "--core.defaultRuleSyntax=v2",
      "--log.level=INFO",
      "--log.level",
      "ERROR",
      "--global.sendAnonymousUsage=false",
      "--entrypoints.websecure.transport.respondingTimeouts.readTimeout=60s",
    ];
    const c = cmd(args);
    for (const a of args) expect(c).toContain(a);
    expect(c.slice(-args.length)).toEqual(args);
  });

  it("timeouts that would hold the edge open or hold off a reload are refused", () => {
    for (const a of [
      "--entrypoints.web.transport.respondingTimeouts.readTimeout=0",
      "--entrypoints.web.transport.respondingTimeouts.readTimeout=0s",
      "--entrypoints.websecure.transport.respondingTimeouts.readTimeout=-1s",
      "--providers.providersThrottleDuration=24h",
      "--providers.providersThrottleDuration=6s",
      "--providers.providersThrottleDuration=soon",
    ])
      expect(() => cmd([a])).toThrow(/^edge\.args: .* sets .* to /);
    for (const a of [
      "--entrypoints.web.transport.respondingTimeouts.readTimeout=60s",
      "--entrypoints.web.transport.respondingTimeouts.readTimeout=1m30s",
      "--entrypoints.web.transport.respondingTimeouts.readTimeout=90",
      "--providers.providersThrottleDuration=2s",
      "--providers.providersThrottleDuration=500ms",
    ])
      expect(cmd([a])).toContain(a);
  });

  it("a value the key can't take is refused", () => {
    expect(() => cmd(["--core.defaultRuleSyntax=v9"])).toThrow(
      /core\.defaultrulesyntax/i,
    );
  });

  it("the trust Den sets is dropped in every spelling, its value too, and edge up says so", () => {
    const args = [
      "-entrypoints.web.proxyprotocol.insecure=true",
      "--entrypoints.web.forwardedHeaders.insecure=true",
      "--entrypoints.websecure.forwardedheaders.trustedips",
      "10.0.0.0/8",
      "--accesslog=true",
    ];
    const cfg = { ...edge, args };
    const c = edgeCommand(cfg);
    expect(c.filter((a) => /insecure|10\.0\.0\.0/.test(a))).toEqual([]);
    expect(c).toContain("--accesslog=true");
    expect(droppedEdgeArgs(cfg)).toEqual(args.slice(0, 4));
    expect(edgeUpNotices(cfg, null)[0]).toMatch(
      /^edge\.args: ignoring -entrypoints\.web\.proxyprotocol\.insecure=true/,
    );
  });
});
