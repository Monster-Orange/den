import { describe, expect, it, jest, beforeEach } from "@jest/globals";

jest.mock("fs");
jest.mock("child_process");
jest.mock("../../../src/shared/environment-manager/opctl.js", () => ({
  findConventionalContainer: jest.fn(),
  pickConventionalContainer: jest.fn(),
  runningDockerNames: jest.fn(),
  runningDockerNamesAsync: jest.fn(),
}));
jest.mock("../../../src/shared/environment-manager/service-runner.js", () => ({
  resolveService: jest.fn(),
  hasRunningOpctlContainers: jest.fn(),
}));
jest.mock("../../../src/shared/environment-manager/health.js", () => ({
  checkServiceHealth: jest.fn(),
}));
jest.mock("../../../src/shared/process/spawn-streaming.js", () => ({
  getServiceLogPath: jest.fn(),
}));
jest.mock("../../../src/shared/manifest/read-manifest.js", () => ({
  readManifest: jest.fn(),
}));
// No focused workspace: stacks run under the default one (`main`).
jest.mock("../../../src/shared/environment-manager/workspaces.js", () => ({
  getFocusedWorkspaceName: () => null,
}));

import * as fs from "fs";
import { execFile } from "child_process";
import {
  pickConventionalContainer,
  runningDockerNamesAsync,
} from "../../../src/shared/environment-manager/opctl.js";
import { resolveService } from "../../../src/shared/environment-manager/service-runner.js";
import { getServiceLogPath } from "../../../src/shared/process/spawn-streaming.js";
import { readManifest } from "../../../src/shared/manifest/read-manifest.js";
import {
  resolveHistorySource,
  searchSystemHistory,
} from "../../../src/ui/server/log-history.js";

// Issue 237: the server's lookup reads docker without blocking
// (runningDockerNamesAsync), then picks among the names.
const mockFind = pickConventionalContainer as jest.MockedFunction<
  typeof pickConventionalContainer
>;
const mockResolve = resolveService as jest.MockedFunction<
  typeof resolveService
>;
const mockLogPath = getServiceLogPath as jest.MockedFunction<
  typeof getServiceLogPath
>;
const mockManifest = readManifest as jest.MockedFunction<typeof readManifest>;
const mockExecFile = execFile as unknown as jest.Mock;
const mockExists = fs.existsSync as jest.MockedFunction<typeof fs.existsSync>;

const LINE = "2026-11-24T18:00:00.000000000Z boom at start";

function withLogCmd(cmd: string): void {
  mockManifest.mockReturnValue({
    name: "shop",
    services: { api: { logs: { local: { type: "shell", cmd } } } },
  } as never);
}

function fakeDocker(byLabels: Record<string, string>): string[][] {
  const calls: string[][] = [];
  mockExecFile.mockImplementation((...args: unknown[]) => {
    const cmd = args[0] as string;
    const argv = args[1] as string[];
    const cb = args[args.length - 1] as (e: Error | null, out: string) => void;
    if (cmd === "grep") return void setImmediate(() => cb(null, `1:${LINE}\n`));
    calls.push(argv);
    const key = argv
      .filter((a) => a.startsWith("label="))
      .sort()
      .join(" ");
    setImmediate(() => cb(null, byLabels[key] ? `${byLabels[key]}\n` : ""));
  });
  return calls;
}

const LABELS = (p: string, s: string) =>
  [
    `label=com.docker.compose.project=${p}`,
    `label=com.docker.compose.service=${s}`,
  ]
    .sort()
    .join(" ");

beforeEach(() => {
  jest.resetAllMocks();
  mockResolve.mockReturnValue({
    repoName: "shop",
    subsystem: "api",
    repoPath: "/repos/Shop.App",
    mode: "dev-managed",
  } as never);
  mockLogPath.mockReturnValue("/home/.den/logs/shop/api.log");
  mockFind.mockReturnValue(null);
  (
    runningDockerNamesAsync as jest.MockedFunction<
      typeof runningDockerNamesAsync
    >
  ).mockResolvedValue([]);
  mockExists.mockImplementation((p) => String(p).includes("/history/"));
});

describe("a service whose only log source is docker compose logs", () => {
  it("has history from its container, found by the compose labels", async () => {
    const calls = fakeDocker({ [LABELS("p", "s")]: "p-s-1" });
    withLogCmd("docker compose -p p logs -f --tail 200 s");
    expect(await resolveHistorySource("shop", "api", "local")).toEqual({
      kind: "docker",
      container: "p-s-1",
    });
    expect(calls).toEqual([
      [
        "ps",
        "--filter",
        "label=com.docker.compose.project=p",
        "--filter",
        "label=com.docker.compose.service=s",
        "--format",
        "{{.Names}}",
      ],
    ]);
  });

  it("has logs_search results from its container", async () => {
    fakeDocker({ [LABELS("p", "s")]: "p-s-1" });
    withLogCmd("docker compose -p p logs -f s");
    const r = await searchSystemHistory(
      { repo: "shop", service: "api" },
      "boom",
      "local",
    );
    expect(r.error).toBeUndefined();
    expect(r.matches.length).toBe(1);
    expect(JSON.stringify(r.matches[0])).toContain("boom at start");
  });

  it("reads --project-name and -p=… forms", async () => {
    fakeDocker({ [LABELS("q", "web")]: "q-web-1" });
    withLogCmd("docker compose --project-name q logs --follow web");
    expect(await resolveHistorySource("shop", "api", "local")).toEqual({
      kind: "docker",
      container: "q-web-1",
    });
    withLogCmd("docker compose -p=q logs web");
    expect(await resolveHistorySource("shop", "api", "local")).toEqual({
      kind: "docker",
      container: "q-web-1",
    });
  });

  it("reads docker-compose (v1) and a -f file before logs", async () => {
    fakeDocker({ [LABELS("p", "s")]: "p_s_1" });
    withLogCmd("docker-compose -f infra/compose.yml -p p logs -f -t s");
    expect(await resolveHistorySource("shop", "api", "local")).toEqual({
      kind: "docker",
      container: "p_s_1",
    });
  });

  it("without -p, the project is the repo folder's name, as compose names it", async () => {
    fakeDocker({ [LABELS("shopapp", "s")]: "shopapp-s-1" });
    withLogCmd("docker compose logs -f s");
    expect(await resolveHistorySource("shop", "api", "local")).toEqual({
      kind: "docker",
      container: "shopapp-s-1",
    });
  });

  it("passes over a global flag that takes no value", async () => {
    fakeDocker({ [LABELS("p", "s")]: "p-s-1" });
    withLogCmd("docker compose --dry-run -p p logs -f s");
    expect(await resolveHistorySource("shop", "api", "local")).toEqual({
      kind: "docker",
      container: "p-s-1",
    });
  });

  it("without -p, a -f file's folder names the project, as compose does", async () => {
    fakeDocker({ [LABELS("infra", "s")]: "infra-s-1" });
    withLogCmd("docker compose -f infra/compose.yml logs -f s");
    expect(await resolveHistorySource("shop", "api", "local")).toEqual({
      kind: "docker",
      container: "infra-s-1",
    });
  });

  it("without -p, COMPOSE_PROJECT_NAME in the command names the project", async () => {
    fakeDocker({ [LABELS("envp", "s")]: "envp-s-1" });
    withLogCmd("COMPOSE_PROJECT_NAME=envp docker compose logs -f s");
    expect(await resolveHistorySource("shop", "api", "local")).toEqual({
      kind: "docker",
      container: "envp-s-1",
    });
  });
});

describe("commands that don't match", () => {
  it("a non-compose command still answers unsupported", async () => {
    const calls = fakeDocker({});
    withLogCmd("journalctl -fu shop");
    const r = await resolveHistorySource("shop", "api", "local");
    expect(r.kind).toBe("unsupported");
    expect(calls).toEqual([]);
  });

  it("compose logs with no running container answers unsupported", async () => {
    fakeDocker({});
    withLogCmd("docker compose -p p logs -f s");
    expect((await resolveHistorySource("shop", "api", "local")).kind).toBe(
      "unsupported",
    );
  });

  it("compose logs naming no service, or several, answers unsupported", async () => {
    const calls = fakeDocker({});
    withLogCmd("docker compose -p p logs -f");
    expect((await resolveHistorySource("shop", "api", "local")).kind).toBe(
      "unsupported",
    );
    withLogCmd("docker compose -p p logs -f a b");
    expect((await resolveHistorySource("shop", "api", "local")).kind).toBe(
      "unsupported",
    );
    expect(calls).toEqual([]);
  });
});

describe("names from the command are checked before docker sees them", () => {
  for (const cmd of [
    "docker compose -p 'x;rm' logs -f s",
    "docker compose -p p logs -f 'x;rm'",
    "docker compose -p --format logs -f s",
    "docker compose -p p logs -f -- --format",
    "docker compose -p P logs -f s",
    "docker compose -p p logs -f 's$(id)'",
    "COMPOSE_PROJECT_NAME='a b' docker compose logs -f s",
  ]) {
    it(`answers unsupported for ${cmd}, and never calls docker`, async () => {
      const calls = fakeDocker({ [LABELS("p", "s")]: "p-s-1" });
      withLogCmd(cmd);
      const r = await resolveHistorySource("shop", "api", "local");
      expect(r.kind).toBe("unsupported");
      expect(calls).toEqual([]);
    });
  }

  it("a repo folder name compose can't use answers unsupported", async () => {
    mockResolve.mockReturnValue({
      repoName: "shop",
      subsystem: "api",
      repoPath: "/repos/...",
      mode: "dev-managed",
    } as never);
    const calls = fakeDocker({});
    withLogCmd("docker compose logs -f s");
    expect((await resolveHistorySource("shop", "api", "local")).kind).toBe(
      "unsupported",
    );
    expect(calls).toEqual([]);
  });
});
