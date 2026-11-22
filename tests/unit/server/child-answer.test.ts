/**
 * Issue 695: the sec3 token-binding case read its orphan's answer as soon
 * as the file existed, before the orphan had written it: "" on a busy
 * shard. A planted delay between the file appearing and its words being
 * written shows it: "it exists" reads "", readAnswer waits for the words.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { END, readAnswer, writeAnswerJs } from "./helpers/child-answer.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-answer-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A child that makes the file at once, then writes its words 600 ms later. */
function slowWriter(file: string, words: string): void {
  const js =
    `require("fs").writeFileSync(${JSON.stringify(file)},"");` +
    `setTimeout(()=>{${writeAnswerJs(file, JSON.stringify(words))}},600)`;
  spawn(process.execPath, ["-e", js], { stdio: "ignore" }).unref();
}

/** The read the test made before issue 695: wait for the file, read it. */
async function readOnceItExists(file: string): Promise<string> {
  while (!fs.existsSync(file)) await new Promise((r) => setTimeout(r, 20));
  return fs.readFileSync(file, "utf8");
}

describe("issue 695: reading a child's answer from a file", () => {
  it("a delay before the child writes gave the old read nothing", async () => {
    const file = path.join(tmp, "old.txt");
    slowWriter(file, "403 agent_token_elsewhere ppid=1");
    expect(await readOnceItExists(file)).toBe("");
  });

  it("readAnswer waits for the whole answer, through the same delay", async () => {
    const file = path.join(tmp, "new.txt");
    slowWriter(file, "403 agent_token_elsewhere ppid=1");
    expect(await readAnswer(file, 10_000)).toBe(
      "403 agent_token_elsewhere ppid=1",
    );
  });

  it("an answer that never ends times out, naming who", async () => {
    const file = path.join(tmp, "never.txt");
    fs.writeFileSync(file, "half");
    await expect(readAnswer(file, 300, "the orphan")).rejects.toThrow(
      "the orphan never answered",
    );
    expect(END.length).toBeGreaterThan(1);
  });
});
