import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runningEdgeServesApi } from "../../../src/shared/edge/exposure.js";
import {
  edgeProofChecker,
  edgeProofFile,
  EDGE_PROOF_HEADER,
  ensureEdgeProof,
} from "../../../src/shared/edge/proof.js";
import {
  commandServesApi,
  edgeCommand,
} from "../../../src/shared/edge/render.js";
import { syncEdgeProof } from "../../../src/shared/edge/runtime.js";
import type { EdgeConfig } from "../../../src/shared/edge/types.js";
import { edgeProofLines } from "../../../src/ui/cli/doctor-command.js";

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-proof-closed-"));
});
afterEach(() => {
  for (const d of [dir, path.join(dir, "dynamic")])
    try {
      fs.chmodSync(d, 0o700);
    } catch {
      /* gone */
    }
  fs.rmSync(dir, { recursive: true, force: true });
});

const cfg = (): EdgeConfig =>
  ({
    org: "acme",
    domain: "acme.localhost",
    aliases: [],
    image: "traefik:v3.7.17",
    workspaces: [],
    routes: { den: "http://host.docker.internal:7000" },
    ports: null,
    stateDir: dir,
    tls: { strategy: "none", ca: null },
    tlsFrom: "explicit",
    httpsRedirect: false,
    dockerLabels: null,
    include: null,
    mounts: {},
    networks: [],
    args: [],
  }) as unknown as EdgeConfig;
const OLD = "cd".repeat(32);
const asks = (proof: string) => ({
  headers: { [EDGE_PROOF_HEADER]: proof } as Record<string, string>,
});

function oldInstall(): void {
  fs.mkdirSync(path.join(dir, "dynamic"), { recursive: true });
  fs.writeFileSync(edgeProofFile(dir), OLD + "\n", { mode: 0o600 });
  fs.writeFileSync(
    path.join(dir, "dynamic", "edge.yml"),
    `X-Den-Edge-Proof: ${OLD}\n`,
    { mode: 0o600 },
  );
}

describe("the proof's rotation fails closed", () => {
  it("a read-only store: the rotation throws, the old proof still proves nothing, and doctor says why", () => {
    if (process.getuid?.() === 0) return;
    oldInstall();
    fs.chmodSync(path.join(dir, "dynamic"), 0o500);
    fs.chmodSync(dir, 0o500);
    expect(() => syncEdgeProof(cfg(), new Set([7000]))).toThrow();
    expect(edgeProofChecker(() => dir)(asks(OLD))).toBe(false);
    const r = edgeProofLines("Acme", "acme", () => dir);
    expect(r.check).toMatchObject({ id: "edge_proof", status: "warn" });
    expect(r.check?.detail).toMatch(/from an older version/);
    expect(r.check?.detail).toMatch(/everyone signs in through it/);
    expect(r.check?.detail).toMatch(/acme edge up --rotate-proof/);
    expect(JSON.stringify(r)).not.toContain(OLD);
  });

  it("a proof of this generation proves, as before", () => {
    const p = ensureEdgeProof(dir);
    expect(edgeProofChecker(() => dir)(asks(p))).toBe(true);
  });
});

describe("a running edge with the API on, found at server start", () => {
  it("commandServesApi: any API or static-config flag, one dash or two", () => {
    for (const c of [
      ["--api.insecure=true"],
      ["-api"],
      ["--API.dashboard=true"],
      ["-configFile=/etc/edge/x.yml"],
      ["--configfile", "/x"],
    ])
      expect([c, commandServesApi([...edgeCommand(cfg()), ...c])]).toEqual([
        c,
        true,
      ]);
    expect(commandServesApi(edgeCommand(cfg()))).toBe(false);
  });

  const inspect = (o: {
    cmd: string[];
    status?: string;
    root?: string;
  }): string =>
    JSON.stringify([
      {
        Id: "abc123",
        Config: {
          Image: "traefik:v3.7.17",
          Cmd: o.cmd,
          Labels: { "den.edge.root": o.root ?? fs.realpathSync(dir) },
        },
        State: { Status: o.status ?? "running" },
        HostConfig: {},
        Mounts: [],
        NetworkSettings: { Networks: {} },
      },
    ]);

  it("runningEdgeServesApi: this state dir's running edge, with an API flag", async () => {
    const api = [...edgeCommand(cfg()), "--api.insecure=true"];
    const calls: string[][] = [];
    const run = (out: string) => async (args: string[]) => {
      calls.push(args);
      return out;
    };
    expect(await runningEdgeServesApi(cfg(), run(inspect({ cmd: api })))).toBe(
      true,
    );
    expect(calls[0]).toEqual(["inspect", "--type", "container", "acme-edge"]);
    for (const out of [
      inspect({ cmd: api, status: "exited" }),
      inspect({ cmd: api, root: "/elsewhere" }),
      inspect({ cmd: edgeCommand(cfg()) }),
      "",
    ])
      expect(await runningEdgeServesApi(cfg(), run(out))).toBe(false);
    expect(
      await runningEdgeServesApi(cfg(), async () => {
        throw new Error(
          "Command failed: docker inspect --type container acme-edge\nError: No such container: acme-edge",
        );
      }),
    ).toBe(false);
    expect(
      await runningEdgeServesApi(cfg(), async () => {
        throw Object.assign(new Error("spawn docker ENOENT"), {
          code: "ENOENT",
        });
      }),
    ).toBe(false);
  });

  it("runningEdgeServesApi: any other docker error isn't a no (the edge may be running with its API on)", async () => {
    await expect(
      runningEdgeServesApi(cfg(), async () => {
        throw new Error(
          "Cannot connect to the Docker daemon at unix:///var/run/docker.sock",
        );
      }),
    ).rejects.toThrow(/Cannot connect/);
    await expect(
      runningEdgeServesApi(cfg(), async () => {
        throw Object.assign(new Error("Command failed: docker inspect"), {
          killed: true,
          signal: "SIGTERM",
        });
      }),
    ).rejects.toThrow(/Command failed/);
  });
});
