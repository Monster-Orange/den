/**
 * Issue 636: the CLI's side of the test-person path (shared/test-person.ts).
 * `<cli> --test-person <command>` on a test bed acts as the person; on any
 * other install it is refused with a clear error and nothing runs.
 */
import * as fs from "fs";
import { DEFAULT_PORT } from "../../shared/constants.js";
import { readWebPort } from "../../shared/edge/config.js";
import { getDistRoot, getStateDir } from "../../shared/paths.js";
import {
  CREATION_PENDING,
  CREATION_RECORD_FILE,
  creationRecordPath,
  verifiedCreationRecord,
} from "../../shared/test-operator.js";
import { product } from "../../shared/product.js";
import {
  dropAgentMarkers,
  TEST_PERSON_ENV,
  notTestBedRefusal,
  useTestPerson,
} from "../../shared/test-person.js";
import { denWebBase } from "../../shared/web/web-dial.js";
import { cliAuthHeaders, readWebSecret } from "../../shared/web/web-secret.js";
import { readWebAuthConfig } from "../../shared/web/web-session.js";

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

/**
 * Issue 1407 (Vision's ruling): `doctor`'s row for an install that holds
 * the creation claim (test-install.created): it is a test install whose
 * test operator may make live checks' few person-only requests on
 * loopback. Always shown when the claim is there, so it is never hidden;
 * none without it. Never prints the record or the secret.
 */
export function testInstallClaimLines(
  title: string,
  stateDir: string = getStateDir(),
): {
  lines: string[];
  check: {
    id: "test_install";
    status: "ok" | "warn";
    state: "sealed" | "pending" | "unverified";
    detail: string;
  } | null;
} {
  const f = creationRecordPath(stateDir);
  if (!fs.existsSync(f)) return { lines: [], check: null };
  let pending = false;
  try {
    pending = fs.readFileSync(f, "utf-8").trim() === CREATION_PENDING;
  } catch {
    pending = false;
  }
  const state = pending
    ? ("pending" as const)
    : verifiedCreationRecord(stateDir, readWebSecret(stateDir))
      ? ("sealed" as const)
      : ("unverified" as const);
  const detail =
    state === "sealed"
      ? `This install was created as a test install (${CREATION_RECORD_FILE}, sealed): its test operator may make the few person-only requests live checks need, on loopback only.`
      : state === "pending"
        ? `This install holds a test-install claim not sealed yet (${CREATION_RECORD_FILE}): its first start seals it, or drops it when that start isn't a test install's.`
        : `This install holds a test-install record (${CREATION_RECORD_FILE}) that doesn't verify here (copied from another install, or its secret changed): it gives no test operator. Remove the file if this isn't a test install.`;
  return {
    lines: [
      "",
      `${title} doctor: Test install`,
      "",
      `  test install  ${state === "unverified" ? "⚠" : "●"}  ${detail}`,
    ],
    check: {
      id: "test_install",
      status: state === "unverified" ? "warn" : "ok",
      state,
      detail,
    },
  };
}
