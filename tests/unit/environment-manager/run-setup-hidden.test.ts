/**
 * runSetupHidden: hidden, non-interactive managed-clone setup.
 *
 * Review-driven behaviors under test:
 *  - the child is spawned DETACHED (own session, no controlling terminal) so
 *    installers that prompt via /dev/tty fail fast instead of blocking forever
 *  - a prompt-looking line followed by silence kills the child and reports
 *    `stalledPrompt` so the caller can point the user at an interactive run
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

import { spawnStreaming } from "../../../src/shared/process/spawn-streaming.js";
import { readManifest } from "../../../src/shared/manifest/read-manifest.js";
import { runSetupHidden } from "../../../src/shared/environment-manager/workspace-manager.js";

const mockSpawn = spawnStreaming as jest.MockedFunction<typeof spawnStreaming>;
const mockManifest = readManifest as jest.MockedFunction<typeof readManifest>;

type OnLine = (line: string) => void;
type OnClose = (code: number) => void;

function captureSpawn(): {
  emit: (line: string) => void;
  close: (code: number) => void;
  args: () => Parameters<typeof spawnStreaming>;
} {
  let onLine: OnLine = () => {};
  let onClose: OnClose = () => {};
  mockSpawn.mockImplementation(((
    ...args: Parameters<typeof spawnStreaming>
  ) => {
    onLine = args[3] as OnLine;
    onClose = args[4] as OnClose;
    return { pid: 4242 } as ReturnType<typeof spawnStreaming>;
  }) as never);
  return {
    emit: (line) => onLine(line),
    close: (code) => onClose(code),
    args: () => mockSpawn.mock.calls[0],
  };
}

beforeEach(() => {
  jest.resetAllMocks();
  jest.useFakeTimers();
  mockManifest.mockReturnValue({
    name: "notes-api",
    services: { api: { commands: { local: { setup: "make setup" } } } },
  } as never);
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("runSetupHidden", () => {
  it("resolves 0 without spawning when the repo declares no setup", async () => {
    mockManifest.mockReturnValue({ name: "x", services: {} } as never);
    // (fs.existsSync isn't mocked here — a fake repoPath has no Makefile.)
    const result = await runSetupHidden("/definitely/not/a/repo", () => {});
    expect(result).toEqual({ code: 0 });
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("spawns the setup DETACHED so it has no controlling terminal", async () => {
    const s = captureSpawn();
    const p = runSetupHidden("/repos/notes-api", () => {});
    s.close(0);
    const result = await p;
    expect(result.code).toBe(0);
    expect(result.stalledPrompt).toBeUndefined();
    // The command is wrapped so stdin feeds an endless "n": unguarded
    // `read -p "… [Y/n]"` prompts are declined and setup CONTINUES, instead of
    // erroring on a failed read. (Layer 3 of the defenses — env, no-tty,
    // stdin-answers, stall-kill.)
    expect(s.args()[0]).toBe("yes n 2>/dev/null | ( make setup )");
    expect(s.args()[6]).toBe(true); // detached — /dev/tty prompts fail fast
    // non-interactive env is applied
    const env = s.args()[2] as NodeJS.ProcessEnv;
    expect(env.CI).toBe("1");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
  });

  it("kills the child and reports stalledPrompt when a [y/N] question goes silent", async () => {
    const killed: Array<number | string> = [];
    jest.spyOn(process, "kill").mockImplementation(((pid: number) => {
      killed.push(pid);
      return true;
    }) as never);
    const s = captureSpawn();
    const lines: string[] = [];
    const p = runSetupHidden("/repos/notes-api", (l) => lines.push(l));

    s.emit("Installing atlas…");
    s.emit(
      "Install 'atlas-darwin-arm64-latest' to '/usr/local/bin/atlas'? [y/N]",
    );
    jest.advanceTimersByTime(15_000);
    expect(killed).toContain(-4242); // group kill of the detached session
    s.close(143); // child dies from the SIGTERM

    const result = await p;
    expect(result.stalledPrompt).toContain("[y/N]");
    expect(result.code).not.toBe(0);
  });

  it("does not kill when output continues after a prompt-looking line", async () => {
    const killSpy = jest
      .spyOn(process, "kill")
      .mockImplementation((() => true) as never);
    const s = captureSpawn();
    const p = runSetupHidden("/repos/notes-api", () => {});

    s.emit("Continue? [y/N]");
    jest.advanceTimersByTime(10_000);
    s.emit("assuming default: N"); // progress — clears the stall timer
    jest.advanceTimersByTime(20_000);
    expect(killSpy).not.toHaveBeenCalled();
    s.close(0);
    const result = await p;
    expect(result).toEqual({ code: 0, stalledPrompt: undefined });
  });
});
