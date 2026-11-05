/**
 * R16 compose.secret_env: values go only into the env of the docker compose
 * process that starts containers, never into the override file, the
 * `compose config` call that feeds it, or an error message.
 */
import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const mockSpawnSync = jest.fn();
jest.mock("child_process", () => ({
  ...(jest.requireActual("child_process") as object),
  spawnSync: (...a: unknown[]) => mockSpawnSync(...a),
}));

import { readStacks } from "../../../src/shared/stacks/config.js";
import { product } from "../../../src/shared/product.js";
import { renderOverride } from "../../../src/shared/stacks/render.js";
import {
  resolveStackSecretEnv,
  stackRestartService,
  stackUp,
  type StackContext,
} from "../../../src/shared/stacks/runtime.js";
import { resolveStacksSecretEnv } from "../../../src/ui/cli/stack-command.js";
import { EnvProvider } from "../../../src/shared/secrets/index.js";
import type { SecretsProvider } from "../../../src/shared/secrets/types.js";
import type {
  ResolvedProject,
  StackConfig,
} from "../../../src/shared/stacks/types.js";
import type { EdgeConfig } from "../../../src/shared/edge/types.js";

const FAKE = "sk-test-123";
const REF = "proj/dev_personal/OPENAI_API_KEY";

let tmp: string;
let ctx: StackContext;
let s: StackConfig;

const resolved: ResolvedProject = {
  name: "webapp-main",
  services: {
    backend: {
      ports: [{ target: 3001 }],
      environment: { OPENAI_API_KEY: "" },
    },
  },
};

type Call = { args: string[]; env: NodeJS.ProcessEnv };
const calls = (): Call[] =>
  mockSpawnSync.mock.calls.map((c) => ({
    args: c[1] as string[],
    env: (c[2] as { env: NodeJS.ProcessEnv }).env,
  }));

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-stack-secret-"));
  fs.mkdirSync(path.join(tmp, "repo"));
  fs.mkdirSync(path.join(tmp, "state", "dynamic"), { recursive: true });
  s = {
    name: "webapp",
    repo: "webapp",
    repoPath: path.join(tmp, "repo"),
    files: ["docker-compose.yml"],
    routes: {},
    generate: [],
    uses: [],
    env: {},
    profiles: [],
    secretEnv: { OPENAI_API_KEY: REF },
  };
  ctx = {
    edge: {
      org: "acme",
      domain: "acme.localhost",
      aliases: [],
      stateDir: path.join(tmp, "state"),
      routes: {},
      workspaces: [],
      ports: null,
    } as unknown as EdgeConfig,
    stacks: { webapp: s },
    workspace: "main",
  };
  mockSpawnSync.mockReset();
  mockSpawnSync.mockImplementation((...a: unknown[]) => {
    const args = a[1] as string[];
    if (args.includes("config"))
      return { status: 0, stdout: JSON.stringify(resolved), stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  });
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("stack config", () => {
  const withConfig = (yml: string): string => {
    const root = path.join(tmp, "dist");
    fs.mkdirSync(path.dirname(path.join(root, product().configFile)), {
      recursive: true,
    });
    fs.writeFileSync(path.join(root, product().configFile), yml);
    return root;
  };

  it("carries secret_env refs (never values) into the stack", () => {
    const root = withConfig(
      `stacks:\n  webapp:\n    repo: webapp\n    secret_env:\n      OPENAI_API_KEY: ${REF}\n`,
    );
    expect(readStacks(root, { manifests: false }).webapp.secretEnv).toEqual({
      OPENAI_API_KEY: REF,
    });
  });

  it("rejects a malformed ref", () => {
    const root = withConfig(
      "stacks:\n  webapp:\n    repo: webapp\n    secret_env:\n      OPENAI_API_KEY: OPENAI_API_KEY\n",
    );
    expect(() => readStacks(root, { manifests: false })).toThrow(
      /stacks\.webapp\.secret_env\.OPENAI_API_KEY: ref "OPENAI_API_KEY" must be exactly three non-empty parts/,
    );
  });
});

describe("renderOverride", () => {
  it("never carries a secret_env key, ref or value", () => {
    const out = renderOverride(
      { ...s, serviceEnv: { backend: { PLAIN: "1" } } },
      {
        ...resolved,
        services: {
          backend: { ...resolved.services.backend, environment: {} },
        },
      },
      "main",
    );
    expect(out).toContain('"PLAIN": "1"');
    expect(out).not.toContain("OPENAI_API_KEY");
    expect(out).not.toContain(REF);
    expect(out).not.toContain(FAKE);
  });
});

describe("stackUp with secret_env", () => {
  it("passes the value to `compose up` only, not to `compose config` or the override", () => {
    stackUp(ctx, s, { secretEnv: { OPENAI_API_KEY: FAKE } });
    const up = calls().find((c) => c.args.includes("up"));
    const config = calls().find((c) => c.args.includes("config"));
    expect(up?.env.OPENAI_API_KEY).toBe(FAKE);
    expect(config?.env.OPENAI_API_KEY).not.toBe(FAKE);
    // No argv carries a value.
    for (const c of calls()) expect(c.args.join(" ")).not.toContain(FAKE);
    const override = fs.readFileSync(
      path.join(ctx.edge.stateDir, "stacks", "webapp-main", "override.yml"),
      "utf-8",
    );
    expect(override).not.toContain(FAKE);
    expect(override).not.toContain("OPENAI_API_KEY");
  });

  it("refuses to start without every declared key, naming keys only", () => {
    expect(() => stackUp(ctx, s)).toThrow(
      /stack webapp: secret_env OPENAI_API_KEY not resolved; not starting it/,
    );
    expect(calls().some((c) => c.args.includes("up"))).toBe(false);
  });

  it("restart of one compose service carries the value too", () => {
    stackRestartService(ctx, s, "backend", {
      secretEnv: { OPENAI_API_KEY: FAKE },
    });
    const restart = calls().find((c) => c.args.includes("restart"));
    expect(restart?.args.slice(-2)).toEqual(["restart", "backend"]);
    expect(restart?.env.OPENAI_API_KEY).toBe(FAKE);
    expect(() => stackRestartService(ctx, s, "backend")).toThrow(
      /not resolved/,
    );
  });
});

describe("resolving a stack's secret_env", () => {
  it("resolves through the provider", async () => {
    const p = new EnvProvider({}, { OPENAI_API_KEY: FAKE });
    await expect(resolveStackSecretEnv(s, p)).resolves.toEqual({
      ok: true,
      env: { OPENAI_API_KEY: FAKE },
    });
  });

  it("a missing key fails every stack before anything runs, without a value", async () => {
    const other: StackConfig = {
      ...s,
      name: "other",
      secretEnv: { OTHER_KEY: "proj/dev_personal/OTHER_KEY" },
    };
    const p = new EnvProvider({}, { OPENAI_API_KEY: FAKE });
    const err = await resolveStacksSecretEnv([s, other], () => p).catch(
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toMatch(/stack other/);
    expect(msg).toMatch(
      /OTHER_KEY \(ref proj\/dev_personal\/OTHER_KEY, provider env\)/,
    );
    expect(msg).not.toContain(FAKE);
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it("never builds the provider when no stack declares secret_env", async () => {
    const provider = jest.fn<() => SecretsProvider>();
    const plain = { ...s, secretEnv: undefined };
    await expect(resolveStacksSecretEnv([plain], provider)).resolves.toEqual(
      new Map(),
    );
    expect(provider).not.toHaveBeenCalled();
  });
});
