/**
 * A throwaway distribution root for op-token.test.ts, set as DEN_ROOT on
 * import (Den resolves its config paths when its modules load, so this must
 * be imported before them).
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export const ROOT = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "op-token-")),
);
fs.mkdirSync(path.join(ROOT, "config", "local"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "den.yml"), "product:\n  name: den\n");
fs.writeFileSync(path.join(ROOT, "config", "den.yml"), "{}\n");
process.env.DEN_ROOT = ROOT;
