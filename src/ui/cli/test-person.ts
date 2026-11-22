/**
 * Issue 636: the CLI's side of the test-person path (shared/test-person.ts).
 * `<cli> --test-person <command>` on a test bed acts as the person; on any
 * other install it is refused with a clear error and nothing runs.
 */
import { DEFAULT_PORT } from "../../shared/constants.js";
import { readWebPort } from "../../shared/edge/config.js";
import { getDistRoot } from "../../shared/paths.js";
import { product } from "../../shared/product.js";
import {
  dropAgentMarkers,
  TEST_PERSON_ENV,
  notTestBedRefusal,
  useTestPerson,
} from "../../shared/test-person.js";
import { denWebBase } from "../../shared/web-dial.js";
import { cliAuthHeaders } from "../../shared/web-secret.js";
import { readWebAuthConfig } from "../../shared/web-session.js";

export interface TestPersonDeps {
  /** The CLI's own environment (its agent markers go once allowed). */
  env: NodeJS.ProcessEnv;
  /** `web.test_install` in the distribution config. */
  mark: () => boolean;
  /**
   * Tells the test bed's server (POST /api/web/test-person, on the path
   * already): it checks the whole binding and records the row.
   */
  announce: (
    command: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
}

/** The command's name and first word, for the audit row (safe words only). */
export function testPersonCommand(command: string | undefined, args: string[]) {
  const end = args.indexOf("--");
  const words = [command ?? "", ...(end === -1 ? args : args.slice(0, end))]
    .filter((w) => w && !w.startsWith("-"))
    .slice(0, 2)
    .map((w) => (/^[A-Za-z0-9._-]{1,64}$/.test(w) ? w : "…"));
  return words.join(" ");
}

function markNow(): boolean {
  try {
    return readWebAuthConfig(getDistRoot(), product().configFile).testInstall;
  } catch {
    return false;
  }
}

async function announceToServer(
  command: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  let port: number;
  try {
    port = readWebPort();
  } catch {
    port = DEFAULT_PORT;
  }
  let r: Response;
  try {
    r = await fetch(`${denWebBase(port)}/api/web/test-person`, {
      method: "POST",
      headers: { "content-type": "application/json", ...cliAuthHeaders() },
      body: JSON.stringify({ command }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return {
      ok: false,
      error: `--test-person is refused: the test bed's web app isn't running, so it can't check this is a test bed. Start it (\`${product().cli} web up\`). Nothing ran.`,
    };
  }
  const b = (await r.json().catch(() => null)) as {
    ok?: boolean;
    error?: string;
  } | null;
  if (r.ok && b?.ok) return { ok: true };
  return {
    ok: false,
    error:
      b?.error ??
      `--test-person is refused (the web app answered ${r.status}). Nothing ran.`,
  };
}

const stdDeps = (): TestPersonDeps => ({
  env: process.env,
  mark: markNow,
  announce: announceToServer,
});

/**
 * Enters the test-person path for `command`, or throws (nothing has run):
 * the install's mark first, then the test bed's server, which checks the
 * rest and records the row. Allowed: the agent markers leave this
 * process's environment and every call goes as the person, on the path.
 */
export async function enterTestPerson(
  command: string,
  d: TestPersonDeps = stdDeps(),
): Promise<void> {
  if (!d.mark()) throw new Error(notTestBedRefusal(product().configFile));
  useTestPerson(true);
  let r: { ok: true } | { ok: false; error: string };
  try {
    r = await d.announce(command);
  } catch (e) {
    r = { ok: false, error: (e as Error).message };
  }
  if (!r.ok) {
    useTestPerson(false);
    throw new Error(r.error);
  }
  dropAgentMarkers(d.env);
  // The processes it starts are on the path too (a Den CLI among them
  // enters it with the same checks).
  d.env[TEST_PERSON_ENV] = "1";
}

/** Whether this run asks for the path: the flag, or a parent's tag. */
export function testPersonAsked(
  flags: { testPerson?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return flags.testPerson === true || env[TEST_PERSON_ENV] === "1";
}

/** `doctor`'s rows: whether this install is a test bed. */
export function testBedLines(
  title: string,
  mark: () => boolean = markNow,
  configFile: string = product().configFile,
): {
  lines: string[];
  check: { id: "test_bed"; status: "ok"; detail: string };
} {
  let bed = false;
  try {
    bed = mark();
  } catch {
    bed = false;
  }
  const detail = bed
    ? `This install is a test bed (web.test_install in ${configFile}): --test-person acts as the person here, while the test launcher runs it on its own state folder with no owner.`
    : "This install is not a test bed: --test-person is refused here.";
  return {
    lines: [
      "",
      `${title} doctor: Test bed`,
      "",
      `  test bed  ${bed ? "●" : "○"}  ${detail}`,
    ],
    check: { id: "test_bed", status: "ok", detail },
  };
}
