/**
 * Issue 1038: each CLI entry's first import. It takes bin/den's record of
 * the caller's install markers out of this process's environment before
 * any other module runs, so nothing this process starts inherits it.
 */
import { takeCallerRecord } from "./caller-env.js";

takeCallerRecord();
