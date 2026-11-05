/**
 * R16 services.<svc>.secret_env: resolved through the secrets provider and
 * set only in the spawned service command's env, never in a line it emits,
 * a tab's command, or a dry run. All or nothing.
 */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { EventEmitter } from "events";
import fs from "fs";
import os from "os";
import path from "path";
import type { ChildProcess } from "child_process";
import type { ResolvedService } from "../../../src/shared/types/index.js";

jest.mock("../../../src/shared/manifest/read-manifest.js");
jest.mock("../../../src/shared/environment-manager/catalog.js");
jest.mock("../../../src/shared/environment-manager/workspaces.js");
jest.mock("../../../src/shared/process/spawn-streaming.js");
jest.mock("../../../src/shared/den-config.js");
jest.mock("../../../src/shared/terminal/tabs.js");
jest.mock("../../../src/shared/cli-tabs.js");
jest.mock("../../../src/shared/environment-manager/opctl.js");

import { readManifest } from "../../../src/shared/manifest/read-manifest.js";
import { readCatalog } from "../../../src/shared/environment-manager/catalog.js";
import {
  getActiveWorkspace,
  getActiveWorkspaces,
  getFocusedWorkspaceName,
  getWorkspaceByName,
  resolveServiceSource,
} from "../../../src/shared/environment-manager/workspaces.js";
import {
  getServiceLogPath,
  spawnStreaming,
} from "../../../src/shared/process/spawn-streaming.js";
import { readUserConfig } from "../../../src/shared/den-config.js";
import { openTab, shellQuote } from "../../../src/shared/terminal/tabs.js";
import {
  forceStopOpctlContainers,
  listRunningOpctlContainers,
  devOpContainerNames,
} from "../../../src/shared/environment-manager/opctl.js";
import {
  prepareServiceSecretEnv,
  previewServiceSecretEnv,
  runServiceCommand,
} from "../../../src/shared/environment-manager/service-runner.js";
import { EnvProvider } from "../../../src/shared/secrets/index.js";
import type { SecretsProvider } from "../../../src/shared/secrets/types.js";

const FAKE = "sk-test-123";
const REF = "proj/dev_personal/SOME_KEY";

const m = <T>(f: T) => f as unknown as jest.Mock;

const resolved: ResolvedService = {
  address: "repo/api",
  repoName: "repo",
  subsystem: "api",
  repoPath: "/repos/repo",
  branch: null,
  mode: "dev-managed",
};

const tick = () => new Promise((r) => setImmediate(r));
const testDaemonsFile = path.join(
  os.tmpdir(),
  `den-service-secret-env-${process.pid}.json`,
);

beforeEach(() => {
  jest.resetAllMocks();
  process.env.DEN_DAEMONS_FILE = testDaemonsFile;
  fs.rmSync(testDaemonsFile, { force: true });
  m(readCatalog).mockReturnValue({ repo: { gh: "x/repo" } });
  const ws = {
    name: "default",
    config: { services: { "repo/api": { mode: "dev-managed" } } },
  };
  m(getActiveWorkspace).mockReturnValue(ws);
  m(getWorkspaceByName).mockImplementation((n) =>
    n === "default" ? ws : null,
  );
  m(getFocusedWorkspaceName).mockReturnValue("default");
  m(getActiveWorkspaces).mockReturnValue(["default"]);
  m(resolveServiceSource).mockReturnValue(resolved);
  m(listRunningOpctlContainers).mockReturnValue([]);
  m(devOpContainerNames).mockReturnValue([]);
  m(forceStopOpctlContainers).mockReturnValue({ stopped: [], failed: [] });
  m(readUserConfig).mockReturnValue({});
  m(shellQuote).mockImplementation((v) => `'${v}'`);
  m(openTab).mockReturnValue({ terminalApp: "iterm2", tabId: "tab-1" });
  m(getServiceLogPath).mockReturnValue("/tmp/den-test-secret-env.log");
  m(readManifest).mockReturnValue({
    name: "repo",
    services: {
      api: {
        secret_env: { SOME_KEY: REF },
        commands: {
          local: {
            up: { cmd: "make up", detachable: false },
            down: "make down",
          },
        },
      },
    },
  });
  m(spawnStreaming).mockImplementation((...a: unknown[]) => {
    const onLine = a[3] as (l: string) => void;
    const onClose = a[4] as (c: number) => void;
    onLine("service says hello");
    onClose(0);
    return new EventEmitter() as unknown as ChildProcess;
  });
});

const run = (
  over: Partial<Parameters<typeof runServiceCommand>[0]> = {},
): { lines: string[]; closed: Promise<number> } => {
  const lines: string[] = [];
  let done: (c: number) => void = () => {};
  const closed = new Promise<number>((r) => (done = r));
  runServiceCommand({
    address: "repo/api",
    command: "up",
    runtime: "daemon",
    onLine: (l) => lines.push(l),
    onClose: (c) => done(c),
    ...over,
  });
  return { lines, closed };
};

describe("runServiceCommand with secret_env", () => {
  it("sets the resolved value in the spawned env, and in no line", async () => {
    const { lines, closed } = run({ secretEnv: { SOME_KEY: FAKE } });
    expect(await closed).toBe(0);
    expect(spawnStreaming).toHaveBeenCalledTimes(1);
    const env = m(spawnStreaming).mock.calls[0][2] as NodeJS.ProcessEnv;
    expect(env.SOME_KEY).toBe(FAKE);
    // Not in the command string either.
    expect(m(spawnStreaming).mock.calls[0][0]).not.toContain(FAKE);
    expect(lines.join("\n")).not.toContain(FAKE);
  });

  it("refuses to start a service whose secret_env was not resolved", async () => {
    const { lines, closed } = run();
    expect(await closed).toBe(1);
    expect(spawnStreaming).not.toHaveBeenCalled();
    expect(lines.join("\n")).toMatch(
      /repo\/api declares secret_env SOME_KEY, which were not resolved; not starting it/,
    );
  });

  it("does not need secrets to stop it", async () => {
    const { closed } = run({ command: "down" });
    expect(await closed).toBe(0);
    expect(spawnStreaming).toHaveBeenCalledTimes(1);
  });

  it("runs as a daemon, not a tab, so the value never reaches a tab's shell", async () => {
    const { lines, closed } = run({
      runtime: "tab",
      secretEnv: { SOME_KEY: FAKE },
    });
    expect(await closed).toBe(0);
    expect(openTab).not.toHaveBeenCalled();
    expect(
      (m(spawnStreaming).mock.calls[0][2] as NodeJS.ProcessEnv).SOME_KEY,
    ).toBe(FAKE);
    expect(lines.join("\n")).toMatch(/running as a daemon, not in a tab/);
  });
});

describe("prepareServiceSecretEnv", () => {
  it("resolves the declared keys through the provider", async () => {
    const p = new EnvProvider({}, { SOME_KEY: FAKE });
    await expect(
      prepareServiceSecretEnv("repo/api", "up", "default", () => p),
    ).resolves.toEqual({ ok: true, secretEnv: { SOME_KEY: FAKE } });
  });

  it("a missing key fails with key, ref and provider, and nothing starts", async () => {
    const p = new EnvProvider({}, {});
    const r = await prepareServiceSecretEnv(
      "repo/api",
      "up",
      "default",
      () => p,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(
      /repo\/api: 1 secret_env key\(s\) could not be resolved; not starting it/,
    );
    expect(r.message).toMatch(
      /SOME_KEY \(ref proj\/dev_personal\/SOME_KEY, provider env\)/,
    );
    expect(spawnStreaming).not.toHaveBeenCalled();
  });

  it("asks the provider nothing for down, or for a service without secret_env", async () => {
    const provider = jest.fn<() => SecretsProvider>();
    await expect(
      prepareServiceSecretEnv("repo/api", "down", "default", provider),
    ).resolves.toEqual({ ok: true, secretEnv: {} });
    m(readManifest).mockReturnValue({
      name: "repo",
      services: { api: { commands: { local: { up: "make up" } } } },
    });
    await expect(
      prepareServiceSecretEnv("repo/api", "up", "default", provider),
    ).resolves.toEqual({ ok: true, secretEnv: {} });
    expect(provider).not.toHaveBeenCalled();
  });

  it("rejects a malformed ref before any provider call", async () => {
    m(readManifest).mockReturnValue({
      name: "repo",
      services: {
        api: {
          secret_env: { SOME_KEY: "SOME_KEY" },
          commands: { local: { up: "make up" } },
        },
      },
    });
    const provider = jest.fn<() => SecretsProvider>();
    const r = await prepareServiceSecretEnv(
      "repo/api",
      "up",
      "default",
      provider,
    );
    expect(r).toMatchObject({ ok: false });
    expect(JSON.stringify(r)).toMatch(/exactly three non-empty parts/);
    expect(provider).not.toHaveBeenCalled();
  });
});

describe("previewServiceSecretEnv (dry run)", () => {
  it("names the keys and never builds a provider", async () => {
    const preview = previewServiceSecretEnv("repo/api", "up", "default");
    expect(preview).toEqual({
      address: "repo/api",
      service: ["SOME_KEY"],
      compose: [],
    });
    await tick();
    expect(JSON.stringify(preview)).not.toContain(REF);
    expect(spawnStreaming).not.toHaveBeenCalled();
  });

  it("names compose.secret_env when Den's stack command runs", () => {
    m(readManifest).mockReturnValue({
      name: "repo",
      compose: { secret_env: { OPENAI_API_KEY: REF } },
      services: { api: {} },
    });
    expect(previewServiceSecretEnv("repo/api", "restart", "default")).toEqual({
      address: "repo/api",
      service: [],
      compose: ["OPENAI_API_KEY"],
    });
    expect(previewServiceSecretEnv("repo/api", "down", "default")).toBeNull();
  });
});
