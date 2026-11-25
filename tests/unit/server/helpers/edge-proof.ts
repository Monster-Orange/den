/**
 * H1 (0.4.48): the real edge adds its proof to every request it forwards
 * to Den's route. Tests that model the edge write an invented proof into
 * their temp edge folder (DEN_EDGE_DIR) and send it as the edge would.
 */
import * as fs from "fs";
import * as path from "path";

/** An invented proof (never a real one). */
export const TEST_EDGE_PROOF = "5e".repeat(32);

/** The header the edge adds. */
export const EDGE_PROOF = { "x-den-edge-proof": TEST_EDGE_PROOF } as const;

/**
 * Write the invented proof where Den reads it (the edge's state folder),
 * as an edge already rotated once (issue 728's marker), so Den's start
 * keeps it instead of rotating it away.
 */
export function writeTestEdgeProof(edgeDir: string): void {
  fs.mkdirSync(edgeDir, { recursive: true });
  fs.writeFileSync(path.join(edgeDir, "den-edge-proof"), TEST_EDGE_PROOF, {
    mode: 0o600,
  });
  fs.writeFileSync(
    path.join(edgeDir, "proof-rotated.json"),
    JSON.stringify({ at: "2026-01-01T00:00:00.000Z", rotated: true }) + "\n",
    { mode: 0o600 },
  );
}
