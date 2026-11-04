/**
 * cliPrompts.confirmWithTimeout: `den up` must never hang at a confirm on
 * an unattended TTY — after the timeout the prompt closes and the timeout
 * value (decline) is returned.
 */
import {
  describe,
  expect,
  it,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";

jest.mock("inquirer", () => ({
  __esModule: true,
  default: { prompt: jest.fn() },
}));

import inquirer from "inquirer";
import { confirmWithTimeout } from "../../../src/ui/cli/stalled-setup-recovery.js";

const mockPrompt = inquirer.prompt as unknown as jest.Mock;

/** An inquirer-shaped prompt: a promise carrying a closable `ui`. */
function stubPrompt(
  answer?: { confirmed: boolean },
  opts?: { reject?: boolean; closeThrows?: boolean },
): {
  close: jest.Mock;
} {
  const close = opts?.closeThrows
    ? jest.fn(() => {
        throw new Error("ERR_USE_AFTER_CLOSE");
      })
    : jest.fn();
  const promise = opts?.reject
    ? Promise.reject(new Error("User force closed the prompt"))
    : answer
      ? Promise.resolve(answer)
      : new Promise(() => {}); // never answered
  (promise as unknown as { ui: { close: jest.Mock } }).ui = { close };
  mockPrompt.mockReturnValue(promise);
  return { close };
}

beforeEach(() => {
  jest.useFakeTimers();
  mockPrompt.mockReset();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("confirmWithTimeout", () => {
  it("returns the user's answer when they respond in time", async () => {
    stubPrompt({ confirmed: true });
    await expect(confirmWithTimeout("Proceed?", 60_000)).resolves.toBe(true);
  });

  it("auto-declines and closes the prompt when nobody answers", async () => {
    const { close } = stubPrompt(); // never answered
    const result = confirmWithTimeout("Proceed?", 60_000);

    await jest.advanceTimersByTimeAsync(60_000);
    await expect(result).resolves.toBe(false);
    expect(close).toHaveBeenCalled(); // stdin released — process can exit
  });

  it("returns the configured timeoutValue on timeout", async () => {
    stubPrompt();
    const result = confirmWithTimeout("Proceed?", 5_000, true, true);
    await jest.advanceTimersByTimeAsync(5_000);
    await expect(result).resolves.toBe(true);
  });

  it("treats a rejecting prompt (Ctrl+D / closed stdin) as decline, not a crash", async () => {
    stubPrompt(undefined, { reject: true });
    // Must resolve immediately — no timer advance, no thrown error.
    await expect(confirmWithTimeout("Proceed?", 60_000)).resolves.toBe(false);
  });

  it("survives ui.close() throwing (readline already closed) on timeout", async () => {
    const { close } = stubPrompt(undefined, { closeThrows: true });
    const result = confirmWithTimeout("Proceed?", 60_000);
    await jest.advanceTimersByTimeAsync(60_000);
    await expect(result).resolves.toBe(false);
    expect(close).toHaveBeenCalled();
  });
});
