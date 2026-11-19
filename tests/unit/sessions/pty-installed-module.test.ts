/**
 * Issue 563: the terminal module Den finds is the one the installed
 * package really ships (not a fake laid out the way the code expects).
 * The real @lydell/node-pty exports no package.json and keeps its binary
 * under prebuilds/<platform>-<arch>/.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { installedPtyModule } from "../../../src/shared/sessions/pty.js";

const ROOT = path.resolve(__dirname, "../../..");
const installed = fs.existsSync(
  path.join(ROOT, "node_modules", "@lydell", "node-pty", "package.json"),
);

describe("installedPtyModule on this checkout's own install", () => {
  (installed ? it : it.skip)(
    "finds the real pty.node, with the package's version",
    () => {
      const info = installedPtyModule(ROOT);
      expect(info).not.toBeNull();
      expect(fs.existsSync(info!.path)).toBe(true);
      expect(path.basename(info!.path)).toBe("pty.node");
      const own = JSON.parse(
        fs.readFileSync(
          path.join(ROOT, "node_modules", "@lydell", "node-pty", "package.json"),
          "utf-8",
        ),
      ) as { version: string };
      expect(info!.version).toBe(own.version);
    },
  );
});
