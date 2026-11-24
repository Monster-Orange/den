#!/usr/bin/env node
/**
 * Issue 635: start a Playwright browser server for test runs that reach
 * a browser through DEN_PW_WS (the nav inventory's: DEN_PW_NAV_WS, issue 1227).
 *
 *   npm run pw:server                 # the general server, port 3000
 *   npm run pw:server -- --port 3917 --name pw-d17
 *   npm run pw:server -- --nav        # the nav inventory's, port 3921
 *
 * The general server uses Playwright's image tag pinned by its multi-arch
 * index digest, so Docker runs the host's own build (arm64 on an
 * Apple-silicon Mac, amd64 on x86): no emulation. The nav inventory's
 * server keeps the exact amd64 build its references were taken on
 * (NAV_BROWSER_IMAGE), with --platform linux/amd64, since text lays out a
 * few px apart on another build.
 *
 * It prints the DEN_PW_WS to use. Stop it with `docker stop <name>`.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { NAV_BROWSER_IMAGE } from "../packages/den-ui/inventory/nav-inventory.js";

/** Playwright's version, as package-lock.json has it (a test keeps them alike). */
export const PW_VERSION = "1.61.1";

/**
 * The general server's image: the tag by its index digest (a manifest list
 * of linux/amd64 sha256:cf0daee9… and linux/arm64 sha256:824f1a78…).
 */
export const BROWSER_SERVER_IMAGE =
  "mcr.microsoft.com/playwright:v1.61.1-noble@sha256:5b8f294aff9041b7191c34a4bab3ac270157a28774d4b0660e9743297b697e48";

/** `docker run` arguments for the server. Throws for a bad port or name. */
export function serverArgs({
  nav = false,
  port = nav ? 3921 : 3000,
  name,
} = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`not a port: ${port}`);
  const n = name ?? (nav ? "pw-nav" : "pw");
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(n))
    throw new Error(`not a container name: ${n}`);
  return [
    "run",
    "-d",
    "--rm",
    "--name",
    n,
    "--init",
    ...(nav ? ["--platform", "linux/amd64"] : []),
    "-p",
    `127.0.0.1:${port}:${port}`,
    nav ? NAV_BROWSER_IMAGE : BROWSER_SERVER_IMAGE,
    "npx",
    "-y",
    `playwright@${PW_VERSION}`,
    "run-server",
    "--port",
    String(port),
    "--host",
    "0.0.0.0",
  ];
}

/**
 * Issue 1227: the line to set. The nav inventory's server has its own
 * variable, so a general server (maybe another build) is never taken for it.
 */
export function envLine(nav, port) {
  return `${nav ? "DEN_PW_NAV_WS" : "DEN_PW_WS"}=ws://127.0.0.1:${port}/\n`;
}

function main(argv) {
  const nav = argv.includes("--nav");
  const val = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const port = val("--port") === undefined ? undefined : Number(val("--port"));
  const args = serverArgs({ nav, port, name: val("--name") });
  execFileSync("docker", args, { stdio: ["ignore", "ignore", "inherit"] });
  const p = args[args.indexOf("--port") + 1];
  process.stdout.write(envLine(nav, p));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`pw-server: ${e.message}\n`);
    process.exit(1);
  }
}
