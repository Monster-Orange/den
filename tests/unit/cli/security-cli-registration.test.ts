/**
 * Security pillar registration in the interactive CLI: the pillar picker
 * offers it, and the results summary sweep includes it.
 */

import { afterEach, describe, expect, it, jest } from "@jest/globals";
import inquirer from "inquirer";
import { CLIPrompts } from "../../../src/ui/cli/prompts.js";
import { ResultsViewer } from "../../../src/ui/cli/results-viewer.js";
import { resultReader } from "../../../src/shared/results/result-reader.js";

const inquirerModule = inquirer as unknown as {
  prompt: (questions: unknown) => Promise<unknown>;
};
const originalPrompt = inquirerModule.prompt;

afterEach(() => {
  inquirerModule.prompt = originalPrompt;
  jest.restoreAllMocks();
});

describe("security pillar CLI registration", () => {
  it("offers security as a pillar choice", async () => {
    let captured: unknown;
    inquirerModule.prompt = async (questions: unknown) => {
      captured = questions;
      return { pillar: "security" };
    };

    expect(await new CLIPrompts().promptForPillar()).toBe("security");
    const [question] = captured as Array<{
      choices: Array<{ name: string; value: string }>;
    }>;
    const choice = question.choices.find((c) => c.value === "security");
    expect(choice?.name).toContain("Security");
  });

  it("includes security in the results summary sweep", async () => {
    jest.spyOn(console, "log").mockImplementation(() => {});
    const getSummary = jest
      .spyOn(resultReader, "getSummary")
      .mockResolvedValue({
        pillar: "security",
        environment: "dev",
        total: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        duration: 0,
        passRate: 0,
      });

    await new ResultsViewer().displaySummary(7);

    expect(getSummary.mock.calls.map(([pillar]) => pillar)).toContain(
      "security",
    );
  });
});
