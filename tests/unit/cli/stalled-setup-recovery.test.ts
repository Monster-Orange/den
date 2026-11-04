/**
 * recoverStalledSetup: the four routes out of a hidden setup that stalled on
 * an interactive prompt during `den up`.
 *
 *   accept + exit 0      → recovered (true), success marker written
 *   accept + exit != 0   → not recovered, NO marker, failure guidance
 *   decline (or timeout) → not recovered, setup never re-run
 *   non-interactive      → not recovered, never even asked
 */
import { describe, expect, it, jest } from "@jest/globals";
import { recoverStalledSetup } from "../../../src/ui/cli/stalled-setup-recovery.js";

const REPO = "notes-api";
const REPO_PATH = "/repos/.den-services/notes-api/main";
const PROMPT = "Install 'atlas' to /usr/local/bin? [y/N]";

function makeDeps(overrides: {
  interactive?: boolean;
  confirmAnswer?: boolean;
  exitCode?: number;
}) {
  const lines: string[] = [];
  const deps = {
    isInteractive: jest.fn(() => overrides.interactive ?? true),
    confirm: jest.fn(async () => overrides.confirmAnswer ?? true),
    runSetupInteractive: jest.fn(async () => overrides.exitCode ?? 0),
    markSetupSucceeded: jest.fn((_repoPath: string) => {}),
    log: (line: string) => lines.push(line),
  };
  return { deps, lines };
}

describe("recoverStalledSetup", () => {
  it("accept + exit 0 → recovered, marker written for the repo path", async () => {
    const { deps, lines } = makeDeps({ confirmAnswer: true, exitCode: 0 });
    const recovered = await recoverStalledSetup(REPO, REPO_PATH, PROMPT, deps);

    expect(recovered).toBe(true);
    expect(deps.runSetupInteractive).toHaveBeenCalledWith(REPO_PATH);
    expect(deps.markSetupSucceeded).toHaveBeenCalledWith(REPO_PATH);
    expect(lines.join("\n")).toContain(PROMPT); // the stalled prompt is shown
  });

  it("accept + nonzero exit → NOT recovered and NO success marker", async () => {
    const { deps, lines } = makeDeps({ confirmAnswer: true, exitCode: 2 });
    const recovered = await recoverStalledSetup(REPO, REPO_PATH, PROMPT, deps);

    expect(recovered).toBe(false);
    expect(deps.markSetupSucceeded).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain("failed (exit 2)");
  });

  it("decline (or confirm timeout) → NOT recovered, setup never re-run", async () => {
    const { deps, lines } = makeDeps({ confirmAnswer: false });
    const recovered = await recoverStalledSetup(REPO, REPO_PATH, PROMPT, deps);

    expect(recovered).toBe(false);
    expect(deps.runSetupInteractive).not.toHaveBeenCalled();
    expect(deps.markSetupSucceeded).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain("make setup"); // do-it-yourself guidance
  });

  it("non-interactive → NOT recovered and never prompts (CI/pipe behavior)", async () => {
    const { deps } = makeDeps({ interactive: false });
    const recovered = await recoverStalledSetup(REPO, REPO_PATH, PROMPT, deps);

    expect(recovered).toBe(false);
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(deps.runSetupInteractive).not.toHaveBeenCalled();
  });
});
