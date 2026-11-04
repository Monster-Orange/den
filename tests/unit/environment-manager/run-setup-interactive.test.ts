/**
 * runSetupInteractive: in-terminal setup re-run after a hidden setup stalled
 * on a prompt.
 *
 * Behaviors under test:
 *  - runs the resolved setup command via spawnInteractive (inherited stdio)
 *    in the repo directory and resolves its exit code
 *  - does NOT apply the non-interactive env (CI, GIT_TERMINAL_PROMPT) —
 *    prompting the user is the point
 *  - resolves 0 without spawning when the repo declares no setup
 */
import {
  describe,
  expect,
  it,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";

jest.mock("../../../src/shared/process/spawn-streaming.js");
jest.mock("../../../src/shared/manifest/read-manifest.js");
jest.mock("../../../src/shared/environment-manager/service-env.js", () => ({
  buildServiceEnv: jest.fn(() => ({})),
}));

import { spawnInteractive } from "../../../src/shared/process/spawn-streaming.js";
import { readManifest } from "../../../src/shared/manifest/read-manifest.js";
import { buildServiceEnv } from "../../../src/shared/environment-manager/service-env.js";
import { runSetupInteractive } from "../../../src/shared/environment-manager/workspace-manager.js";

const mockSpawn = spawnInteractive as jest.MockedFunction<
  typeof spawnInteractive
>;
const mockManifest = readManifest as jest.MockedFunction<typeof readManifest>;
const mockServiceEnv = buildServiceEnv as jest.MockedFunction<
  typeof buildServiceEnv
>;

type OnClose = (code: number) => void;

function captureSpawn(): {
  close: (code: number) => void;
  args: () => Parameters<typeof spawnInteractive>;
} {
  let onClose: OnClose = () => {};
  mockSpawn.mockImplementation(((
    ...args: Parameters<typeof spawnInteractive>
  ) => {
    onClose = args[2] as OnClose;
    return { pid: 4242 } as ReturnType<typeof spawnInteractive>;
  }) as never);
  return {
    close: (code) => onClose(code),
    args: () => mockSpawn.mock.calls[0],
  };
}

// Ambient CI/hook env would leak through `{ ...process.env }` and make the
// "suppressors absent" assertions flaky — pin them to absent for the test.
const AMBIENT = ["CI", "HUSKY", "GIT_TERMINAL_PROMPT"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  jest.resetAllMocks();
  for (const k of AMBIENT) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  // Sentinel proving the child inherits the parent env (PATH/HOME/agent
  // sockets) — dropping `...process.env` from the spawn env must fail here.
  process.env.GX_TEST_PARENT_ENV = "inherited";
  mockManifest.mockReturnValue({
    name: "notes-api",
    services: { api: { commands: { local: { setup: "make setup" } } } },
  } as never);
});

afterEach(() => {
  for (const k of AMBIENT) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  delete process.env.GX_TEST_PARENT_ENV;
  jest.restoreAllMocks();
});

describe("runSetupInteractive", () => {
  it("resolves 0 without spawning when the repo declares no setup", async () => {
    mockManifest.mockReturnValue({ name: "x", services: {} } as never);
    // (fs.existsSync isn't mocked here — a fake repoPath has no Makefile.)
    const code = await runSetupInteractive("/definitely/not/a/repo");
    expect(code).toBe(0);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("runs the setup command in the repo dir and resolves its exit code", async () => {
    const s = captureSpawn();
    const p = runSetupInteractive("/repos/notes-api");
    s.close(2);
    expect(await p).toBe(2);
    expect(s.args()[0]).toBe("make setup");
    expect(s.args()[3]).toBe("/repos/notes-api"); // cwd
  });

  it("keeps the env interactive (no CI/GIT_TERMINAL_PROMPT) but includes the den service env", async () => {
    mockServiceEnv.mockReturnValue({ INFRA_SECRETS_FILE: "/tmp/secrets" });
    const s = captureSpawn();
    const p = runSetupInteractive("/repos/notes-api");
    s.close(0);
    expect(await p).toBe(0);
    const env = s.args()[1] as NodeJS.ProcessEnv;
    expect(env.INFRA_SECRETS_FILE).toBe("/tmp/secrets");
    expect(env.GX_TEST_PARENT_ENV).toBe("inherited"); // parent env inherited
    // The whole point is answering prompts — the suppressors must be absent.
    expect(env.CI).toBeUndefined();
    expect(env.GIT_TERMINAL_PROMPT).toBeUndefined();
    expect(env.HUSKY).toBeUndefined();
  });
});
