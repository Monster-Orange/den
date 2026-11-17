/**
 * Where the kit's font files are (src/fonts), found from this file itself:
 * the CommonJS side of the "#den-ui-fonts-dir" import (package.json
 * "imports"), as a test runner that compiles to CommonJS loads it.
 */
const path = require("node:path");

exports.FONTS_DIR = path.join(__dirname, "..", "src", "fonts");
