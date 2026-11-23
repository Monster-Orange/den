/**
 * Issue 866: the bed's Den server has a gate folder of its own (the
 * bed-gate-dir proof on v0.4.85), so no live check may skip for its lack.
 * Subject: gate/714.mjs and gate/739.mjs.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";

const GATE = path.resolve(__dirname, "../../../gate");

describe("issue 866: no live check skips for the bed's gate folder", () => {
  it("no gate module says needs-bed-gate-dir", () => {
    const hits = fs
      .readdirSync(GATE)
      .filter((f) => f.endsWith(".mjs"))
      .filter((f) =>
        fs
          .readFileSync(path.join(GATE, f), "utf-8")
          .includes("needs-bed-gate-dir"),
      );
    expect(hits).toEqual([]);
  });
});
