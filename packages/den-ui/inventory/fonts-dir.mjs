/**
 * Where the kit's font files are (src/fonts), found from this file itself:
 * the ES module side of the "#den-ui-fonts-dir" import (package.json
 * "imports"). fonts-dir.cjs is the CommonJS side.
 */
import { fileURLToPath } from "node:url";

export const FONTS_DIR = fileURLToPath(
  new URL("../src/fonts/", import.meta.url),
);
