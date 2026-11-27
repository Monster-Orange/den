/**
 * An agent's shell reaches the install it runs under (src/shared/agents/runtimes.ts,
 * agentSessionEnv). Its env is an allowlist, so an install with its own state
 * folder (`<PREFIX>_HOME`, as every test install has) or its own root used to
 * reach only the agent's MCP config, never its shell. A CLI command the agent
 * ran there (`<cli> mcp --call …`) then read the default state folder, and
 * its token was "not a live actor token of this distribution".
 *
 * The session env now carries the install's location: DEN_ROOT,
 * `<PREFIX>_ROOT` and `<PREFIX>_HOME`, the same values the MCP config gets.
 * Paths only: nothing else of the caller's comes along.
 *
 * The integration half runs the real entry (bin/den mcp --call) with the env
 * an agent's shell gets, against a stub web server. Invented names only.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawn } from "child_process";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { agentSessionEnv } from "../../../src/shared/agents/runtimes.js";
import {
  mintActorToken,
  writeActorTokenFile,
} from "../../../src/shared/actor-token.js";

const ENGINE = path.resolve(__dirname, "../../..");
const RT = { envPassthrough: [], launchEnv: [] };

describe("an agent's session env carries the install's location", () => {
  it("DEN_ROOT and DEN_HOME from the caller, as the MCP config gets them", () => {
    const env = agentSessionEnv(
      {
        PATH: "/usr/bin:/bin",
        HOME: "/Users/someone",
        DEN_ROOT: "/srv/acme",
        DEN_HOME: "/srv/acme-state",
        SOME_TOKEN: "never-this",
      },
      RT,
      {},
      "scout",
      "/srv/acme-state/actor-token/scout/token",
    );
    expect(env.DEN_ROOT).toBe("/srv/acme");
    expect(env.DEN_HOME).toBe("/srv/acme-state");
    expect(env.DEN_ACTOR_TOKEN_FILE).toBe(
      "/srv/acme-state/actor-token/scout/token",
    );
    expect(env.SOME_TOKEN).toBeUndefined();
  });

  it("none set: none added", () => {
    const env = agentSessionEnv(
      { PATH: "/usr/bin:/bin", HOME: "/Users/someone" },
      RT,
      {},
      "scout",
    );
    expect(env.DEN_ROOT).toBeUndefined();
    expect(env.DEN_HOME).toBeUndefined();
  });

  it("an empty value is not passed on", () => {
    const env = agentSessionEnv(
      { PATH: "/usr/bin:/bin", HOME: "/Users/someone", DEN_HOME: "" },
      RT,
      {},
      "scout",
    );
    expect("DEN_HOME" in env).toBe(false);
  });
});

describe("bin/den mcp --call from an agent's shell, on an install with its own home", () => {
  let root = "";
  let stub: http.Server;
  let port = 0;

  beforeAll(async () => {
    root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "den-agent-home-")),
    );
    fs.writeFileSync(path.join(root, "den.yml"), "product:\n  name: den\n");
    fs.mkdirSync(path.join(root, "config"));
    fs.writeFileSync(
      path.join(root, "config", "den.yml"),
      "environments: [local]\n",
    );
    fs.mkdirSync(path.join(root, "home"));
    fs.mkdirSync(path.join(root, "user"));
    stub = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const body =
        url.pathname === "/api/server-info"
          ? { pid: process.pid, version: "0.4.4", root, product: "den" }
          : url.pathname === "/api/workspaces"
            ? {
                active: ["north"],
                focus: "north",
                workspaces: { north: { services: { shop: {} } } },
              }
            : url.pathname === "/api/services"
              ? [
                  {
                    repo: "shop",
                    service: "api",
                    repoPath: "/x",
                    commands: ["up"],
                  },
                ]
              : [];
      res.writeHead(200, {
        "Content-Type": "application/json",
        Connection: "close",
      });
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
    port = (stub.address() as AddressInfo).port;
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((r) => stub.close(() => r()));
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("the agent's token is found in the install's own state folder", async () => {
    const stateDir = path.join(root, "home");
    const { token } = mintActorToken(stateDir, {
      agentId: "scout",
      workspace: "north",
      sessionName: "scout",
    });
    const tokenFile = writeActorTokenFile(stateDir, "scout", token);
    // The env `agents start` gives the agent's session, from a server that
    // runs with its own home. The person's HOME is elsewhere, so the
    // default state folder (~/.den) holds no token.
    const shellEnv = agentSessionEnv(
      {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: path.join(root, "user"),
        DEN_ROOT: root,
        DEN_HOME: stateDir,
      },
      RT,
      {},
      "scout",
      tokenFile,
    );
    const r = await new Promise<{
      code: number | null;
      out: string;
      err: string;
    }>((resolve, reject) => {
      const child = spawn(
        path.join(ENGINE, "bin", "den"),
        [
          "mcp",
          "--port",
          String(port),
          "--workspace",
          "north",
          "--actor",
          "agent:scout",
          "--call",
          "services",
        ],
        // The agent's working folder is its repo, not the install's root;
        // the distribution's CLI wrapper sets DEN_ROOT (bin/<cli>).
        {
          cwd: path.join(root, "user"),
          env: { ...shellEnv, DEN_ROOT: root },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let out = "";
      let err = "";
      child.stdout.on("data", (d: Buffer) => (out += d.toString()));
      child.stderr.on("data", (d: Buffer) => (err += d.toString()));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, out, err }));
    });
    expect(r.err).not.toContain("not a live actor token");
    expect(r.code).toBe(0);
    expect(r.out).toContain("shop");
  }, 30_000);
});
