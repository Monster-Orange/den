/**
 * Issue 89: a start or resume whose agent exited at once answers with its
 * exit code and its last lines in the error's own words (what the start
 * dialog and the working pop-up show), and all of its tail for the page.
 */
import { describe, expect, it } from "@jest/globals";
import { earlyExitAnswer } from "../../../src/ui/server/agent-routes.js";

const early = (tail: string[], exitCode?: number) => ({
  ...(exitCode === undefined ? {} : { exitCode }),
  tail,
  said: tail.join("\n"),
  sessionName: "north:planner",
});

describe("the answer to an agent that exited at once", () => {
  it("names its exit code and its last three lines", () => {
    const a = earlyExitAnswer(
      "planner",
      early(["one", "two", "Error: no such flag --bogus", "Usage: x"], 1),
    );
    expect(a).toMatchObject({
      ok: false,
      code: "exited_at_once",
      exitCode: 1,
      session: "north:planner",
    });
    expect(a.error).toBe(
      "agent planner exited at once (exit 1). Its last 3 lines: two / Error: no such flag --bogus / Usage: x",
    );
    expect(a.tail).toEqual([
      "one",
      "two",
      "Error: no such flag --bogus",
      "Usage: x",
    ]);
  });

  it("one line", () => {
    expect(earlyExitAnswer("planner", early(["boom"], 2)).error).toBe(
      "agent planner exited at once (exit 2). Its last line: boom",
    );
  });

  it("nothing printed: says so", () => {
    expect(earlyExitAnswer("planner", early([])).error).toBe(
      "agent planner exited at once. It printed nothing",
    );
  });
});
