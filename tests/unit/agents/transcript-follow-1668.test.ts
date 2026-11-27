import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import { createRequire } from "module";
import * as os from "os";
import * as path from "path";
import {
  resetFollowers,
  transcriptTitle,
} from "../../../src/shared/agents/transcript-follow.js";

const FILES = 300;
let dir = "";
const files: string[] = [];
const realFs = createRequire(__filename)("fs") as {
  openSync: (...a: unknown[]) => number;
};

function opensDuring(fn: () => void): number {
  let n = 0;
  const { openSync } = realFs;
  realFs.openSync = (p: unknown, ...rest: unknown[]) => {
    if (files.includes(String(p))) n++;
    return openSync(p, ...rest);
  };
  try {
    fn();
  } finally {
    realFs.openSync = openSync;
  }
  return n;
}

beforeAll(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-1668f-")));
  for (let i = 0; i < FILES; i++) {
    const f = path.join(dir, `t${i}.jsonl`);
    fs.writeFileSync(
      f,
      JSON.stringify({ type: "custom-title", customTitle: `agent ${i}` }) +
        "\n",
    );
    files.push(f);
  }
  resetFollowers();
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("titles followed for more transcripts than the old cap (256)", () => {
  it("a second walk over 300 in the same order opens none of them", () => {
    expect(opensDuring(() => files.forEach((f) => transcriptTitle(f)))).toBe(
      FILES,
    );
    expect(opensDuring(() => files.forEach((f) => transcriptTitle(f)))).toBe(0);
    expect(transcriptTitle(files[7])).toBe("agent 7");
  });
});
