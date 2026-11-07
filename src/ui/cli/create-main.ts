/**
 * Entry point for `den create` (bin/den routes `create` here). Kept apart
 * from the main CLI, which needs a distribution root at import time: create
 * runs before one exists, e.g. `npx @monster-orange/den create acme`.
 */
import { runCreate } from "./create.js";

const cwd = process.env.DEN_INVOKE_CWD?.trim() || process.cwd();
process.exit(await runCreate(process.argv.slice(2), cwd));
