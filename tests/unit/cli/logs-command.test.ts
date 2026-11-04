/**
 * `den logs [repo]`: target resolution (explicit args alias-resolved like
 * use-local/use-managed, addresses pass through, cwd repo as fallback) and the
 * tail loop (wait-for-source polling, not-found messaging, signal/EPIPE
 * cleanup so a live `docker logs -f` child is never orphaned).
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";

jest.mock("../../../src/shared/environment-manager/log-tail.js", () => ({
  resolveTailSources: jest.fn(),
  followTailSources: jest.fn(),
}));

import {
  followTailSources,
  resolveTailSources,
} from "../../../src/shared/environment-manager/log-tail.js";
import {
  resolveLogsTarget,
  tailServiceLogs,
} from "../../../src/ui/cli/logs-command.js";
import { buildAliasResolver } from "../../../src/shared/environment-manager/derivation/alias.js";
import type { ResolvedService } from "../../../src/shared/types/index.js";

const mockResolveSources = resolveTailSources as jest.MockedFunction<
  typeof resolveTailSources
>;
const mockFollowSources = followTailSources as jest.MockedFunction<
  typeof followTailSources
>;

const alias = buildAliasResolver({
  aliases: { "test-repo": ["tr-alias"] },
});

const noCwd = (): null => null;
const cwdIn = (repo: string) => () => ({ repo, root: `/repos/${repo}` });

describe("resolveLogsTarget", () => {
  it("accepts a known canonical repo name", () => {
    expect(resolveLogsTarget(["test-repo"], alias, noCwd)).toEqual({
      kind: "repo",
      target: "test-repo",
    });
  });

  it("resolves an alias to its canonical repo", () => {
    expect(resolveLogsTarget(["tr-alias"], alias, noCwd)).toEqual({
      kind: "repo",
      target: "test-repo",
    });
  });

  it("rejects an unknown repo without falling back to the cwd", () => {
    expect(resolveLogsTarget(["nope"], alias, cwdIn("test-repo"))).toEqual({
      kind: "unknown-repo",
      arg: "nope",
    });
  });

  it("passes a repo/subsystem address through untouched", () => {
    expect(resolveLogsTarget(["shop/db"], alias, noCwd)).toEqual({
      kind: "address",
      target: "shop/db",
    });
  });

  it("uses the cwd repo when no arg is given", () => {
    expect(resolveLogsTarget([], alias, cwdIn("test-repo"))).toEqual({
      kind: "repo",
      target: "test-repo",
    });
  });

  it("reports when run outside a known repo with no arg", () => {
    expect(resolveLogsTarget([], alias, noCwd)).toEqual({
      kind: "no-cwd-repo",
    });
  });

  it("skips dash-flags when looking for the positional arg", () => {
    expect(resolveLogsTarget(["-x", "test-repo"], alias, noCwd)).toEqual({
      kind: "repo",
      target: "test-repo",
    });
  });
});

// ── tailServiceLogs ───────────────────────────────────────────────────────────

type TailHandle = ReturnType<typeof followTailSources>;
type TailSource = ReturnType<typeof resolveTailSources>[number];

const svc = {
  address: "files-api",
  repoName: "files-api",
} as unknown as ResolvedService;
const source = { kind: "daemon-file", path: "/tmp/x.log" } as TailSource;

describe("tailServiceLogs", () => {
  let logSpy: jest.SpiedFunction<typeof console.log>;
  let resolveDone: (code: number) => void = () => {};
  let stop: jest.Mock;

  /** followTailSources mock: pending tail whose handlers/stop we can drive. */
  const installHandle = (): void => {
    stop = jest.fn();
    mockFollowSources.mockImplementation(
      () =>
        ({
          stop,
          done: new Promise<number>((r) => {
            resolveDone = r;
          }),
        }) as unknown as TailHandle,
    );
  };

  beforeEach(() => {
    jest.clearAllMocks();
    installHandle();
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    jest.useRealTimers();
  });

  const logged = () => logSpy.mock.calls.map((c) => String(c[0])).join("\n");

  it("explains and exits 1 when no log source exists (and no wait asked)", async () => {
    mockResolveSources.mockReturnValue([]);
    expect(await tailServiceLogs(svc)).toBe(1);
    expect(logged()).toContain("No local log source found for files-api");
    expect(mockFollowSources).not.toHaveBeenCalled();
  });

  it("tails, forwards line/meta output, and returns the tail's exit code", async () => {
    mockResolveSources.mockReturnValue([source]);
    const p = tailServiceLogs(svc);
    await Promise.resolve(); // let listeners attach
    const opts = mockFollowSources.mock.calls[0][1];
    opts.onLine("a log line");
    opts.onMeta("switched source");
    resolveDone(0);
    expect(await p).toBe(0);
    expect(mockFollowSources.mock.calls[0][0]).toEqual([source]);
    expect(logged()).toContain("a log line");
    expect(logged()).toContain("switched source");
  });

  it("stops the tail on signals and stdout EPIPE, and detaches its handlers", async () => {
    mockResolveSources.mockReturnValue([source]);
    const sigBefore = process.listeners("SIGTERM").length;
    const errBefore = process.stdout.listeners("error").length;

    const p = tailServiceLogs(svc);
    await Promise.resolve();

    // Our handlers are the newly-appended ones; invoke them directly rather
    // than emitting real events (which would also fire jest's own listeners).
    const sigHandler = process.listeners("SIGTERM").at(-1) as () => void;
    const errHandler = process.stdout.listeners("error").at(-1) as () => void;
    expect(process.listeners("SIGTERM").length).toBe(sigBefore + 1);
    sigHandler();
    expect(stop).toHaveBeenCalledTimes(1);
    errHandler();
    expect(stop).toHaveBeenCalledTimes(2);

    resolveDone(130);
    expect(await p).toBe(130);
    expect(process.listeners("SIGTERM").length).toBe(sigBefore);
    expect(process.stdout.listeners("error").length).toBe(errBefore);
  });

  it("polls until a source appears when asked to wait", async () => {
    jest.useFakeTimers();
    mockResolveSources
      .mockReturnValueOnce([])
      .mockReturnValueOnce([])
      .mockReturnValue([source]);
    const p = tailServiceLogs(svc, { waitForSourceMs: 10_000 });
    await jest.advanceTimersByTimeAsync(2_000); // two 1s polls
    resolveDone(0);
    expect(await p).toBe(0);
    expect(mockResolveSources).toHaveBeenCalledTimes(3);
    expect(mockFollowSources).toHaveBeenCalledTimes(1);
  });

  it("gives up when the wait deadline passes with no source", async () => {
    jest.useFakeTimers();
    mockResolveSources.mockReturnValue([]);
    const p = tailServiceLogs(svc, { waitForSourceMs: 2_500 });
    await jest.runAllTimersAsync();
    expect(await p).toBe(1);
    expect(mockFollowSources).not.toHaveBeenCalled();
    expect(logged()).toContain("No local log source found");
  });
});
