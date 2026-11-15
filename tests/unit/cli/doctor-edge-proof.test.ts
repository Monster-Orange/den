/**
 * H1 (0.4.48): doctor says whether the edge carries Den's proof, and how to
 * rotate it, and never prints the proof itself. Temp folders, an invented
 * edge. No Docker.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { edgeProofLines } from "../../../src/ui/cli/doctor-command.js";
import { ensureEdgeProof } from "../../../src/shared/edge/proof.js";

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-dproof-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});
const edgeYml = (text: string) => {
  fs.mkdirSync(path.join(dir, "dynamic"), { recursive: true });
  fs.writeFileSync(path.join(dir, "dynamic", "edge.yml"), text);
};
const run = () => edgeProofLines("Acme", "acme", () => dir);

describe("doctor: the edge's proof", () => {
  it("carried: ok, says how to rotate, never prints the proof", () => {
    const p = ensureEdgeProof(dir);
    edgeYml(`X-Den-Edge-Proof: ${p}\n`);
    const r = run();
    expect(r.check).toMatchObject({ id: "edge_proof", status: "ok" });
    expect(r.lines.join("\n")).toMatch(/acme edge up --rotate-proof/);
    expect(JSON.stringify(r)).not.toContain(p);
  });

  it("not carried yet (an edge from before 0.4.48): warn, and what fixes it", () => {
    edgeYml("# old\n");
    const r = run();
    expect(r.check).toMatchObject({ id: "edge_proof", status: "warn" });
    expect(r.check.detail).toMatch(/signs in/);
    expect(r.check.detail).toMatch(/acme edge up/);
  });

  it("no edge set up here, or no edge config: says nothing", () => {
    expect(run().lines).toEqual([]);
    expect(edgeProofLines("Acme", "acme", () => null).lines).toEqual([]);
  });
});
