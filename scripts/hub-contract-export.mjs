#!/usr/bin/env node
/**
 * Issue 521: write docs/hub-contract/den-<version>/ from the code that
 * builds each request Den makes to Hub (src/shared/hub-contract.ts calls
 * Den's real calls with placeholder inputs; nothing here is by hand),
 * then keep only the newest three den-* folders.
 *
 *   npm run hub-contract:export
 *
 * Runs under tsx (it imports Den's TypeScript source). A release commit
 * runs it, so the folder is named for the version being released; the
 * drift test (tests/unit/shared/hub-contract.test.ts) fails when a
 * request changes without it.
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildHubContract,
  contractFolderName,
  writeHubContract,
} from "../src/shared/hub-contract.ts";

const root = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "docs",
  "hub-contract",
);
const c = await buildHubContract();
const gone = writeHubContract(root, c);
console.log(
  `hub-contract: wrote ${contractFolderName(c.manifest.den_version)} for ${c.manifest.den_version} (${Object.keys(c.requests).length} requests)` +
    (gone.length ? `; removed ${gone.join(", ")}` : ""),
);
