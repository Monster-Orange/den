/**
 * Issue 1215: what a test install's fixture person (a live check) may do
 * with projects. It may create one, and activate, deactivate and delete
 * the projects it made, through the existing routes (workspace-routes.ts).
 * Nothing else in the project family, no project it didn't make, no
 * clean-up of clones, never with an agent's claim on its session, and
 * never on an install that isn't a test install. Agents' tokens are
 * refused these routes everywhere (request-guard.ts AGENT_PERSON_WRITES).
 *
 * The projects it made are listed in the state folder
 * (src/shared/fixture-projects-store.ts).
 */
import { FIXTURE_LABEL } from "../../shared/fixture-person.js";

/** An act on a project, as the routes name it. */
export type FixtureProjectOp =
  | "create"
  | "activate"
  | "deactivate"
  | "delete"
  | "focus"
  | "use"
  | "rename";

export interface FixtureProjectAsk {
  /** The install is a bound test install now (testInstallNow()). */
  testInstall: boolean;
  /** An agent's claim (x-den-actor) is on the fixture session. */
  claimed: boolean;
  op: FixtureProjectOp;
  /** The project's slug (for create: the slug it would get). */
  slug: string;
  /** The projects the fixture person made (fixtureProjects()). */
  mine: readonly string[];
  /** Delete's clean-up flags. */
  flags?: {
    cleanupDirectory?: boolean;
    cleanupDev?: boolean;
    cleanupDen?: boolean;
  };
  /** Delete's agents choice. */
  agents?: string;
}

export interface FixtureProjectRefusal {
  status: 403;
  code: "not_test_install" | "fixture_scope" | "fixture_not_its_project";
  error: string;
}

const ALLOWED: ReadonlySet<FixtureProjectOp> = new Set([
  "create",
  "activate",
  "deactivate",
  "delete",
]);

/** Why the fixture person may not do this, or null when it may. */
export function fixtureProjectRefusal(
  a: FixtureProjectAsk,
): FixtureProjectRefusal | null {
  const no = (
    code: FixtureProjectRefusal["code"],
    error: string,
  ): FixtureProjectRefusal => ({ status: 403, code, error });
  if (!a.testInstall)
    return no(
      "not_test_install",
      `The ${FIXTURE_LABEL} changes projects only on a test install.`,
    );
  if (a.claimed)
    return no(
      "fixture_scope",
      `An agent can't change projects as the ${FIXTURE_LABEL}.`,
    );
  if (!ALLOWED.has(a.op))
    return no(
      "fixture_scope",
      `The ${FIXTURE_LABEL} may create, activate, deactivate and delete its own projects: not ${a.op}.`,
    );
  if (a.op === "create") return null;
  if (!a.mine.includes(a.slug))
    return no(
      "fixture_not_its_project",
      `The ${FIXTURE_LABEL} may change only the projects it made: "${a.slug}" isn't one.`,
    );
  if (a.op === "delete") {
    const f = a.flags ?? {};
    if (f.cleanupDirectory || f.cleanupDev || f.cleanupDen)
      return no(
        "fixture_scope",
        `The ${FIXTURE_LABEL} deletes a project without removing any folder or clone.`,
      );
    if (a.agents !== undefined && a.agents !== "stop")
      return no(
        "fixture_scope",
        `The ${FIXTURE_LABEL} may only stop a deleted project's agents, not move them.`,
      );
  }
  return null;
}

let testInstallNow: () => boolean = () => false;

/**
 * Whether the install is a bound test install now. The server sets it
 * (index.ts testInstallNow); until then, no: every fixture project act is
 * refused.
 */
export function fixtureTestInstall(): boolean {
  try {
    return testInstallNow();
  } catch {
    return false;
  }
}

/** The server's test-install check (index.ts). */
export function setFixtureTestInstall(fn: () => boolean): void {
  testInstallNow = fn;
}

export {
  fixtureProjects,
  forgetFixtureProject,
  rememberFixtureProject,
} from "../../shared/fixture-projects-store.js";
