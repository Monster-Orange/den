/**
 * Issue 1215: the projects a test install's fixture person made
 * (fixture-projects.json in the state folder), the only ones it may
 * activate, deactivate or delete (src/ui/server/fixture-projects.ts).
 *
 * A missing, unreadable or hand-edited file means none. Every project
 * created or deleted by anyone forgets its slug (createWorkspace and
 * deleteWorkspaceConfig call forgetFixtureProject), and only the server's
 * fixture create remembers one after: a name the fixture person once used
 * that is now a person's project is never its own.
 */
import * as fs from "fs";
import * as path from "path";
import { writeFileAtomic } from "./atomic-write.js";

const FILE = "fixture-projects.json";
/** A project slug as workspaceSlug makes it. */
const SLUG = /^[a-z0-9][a-z0-9._-]{0,99}$/;

/** The projects the fixture person made, from the state folder. */
export function fixtureProjects(stateDir: string): string[] {
  try {
    const v = JSON.parse(
      fs.readFileSync(path.join(stateDir, FILE), "utf-8"),
    ) as { projects?: unknown };
    if (!Array.isArray(v.projects)) return [];
    return [
      ...new Set(
        v.projects.filter(
          (s): s is string =>
            typeof s === "string" && SLUG.test(s) && !s.includes(".."),
        ),
      ),
    ];
  } catch {
    return [];
  }
}

function write(stateDir: string, projects: string[]): void {
  writeFileAtomic(
    path.join(stateDir, FILE),
    JSON.stringify({ projects }, null, 2) + "\n",
    { mode: 0o600 },
  );
}

/** Records a project the fixture person made. */
export function rememberFixtureProject(stateDir: string, slug: string): void {
  const now = fixtureProjects(stateDir);
  if (!now.includes(slug)) write(stateDir, [...now, slug]);
}

/** Forgets a project once it is deleted (by anyone). */
export function forgetFixtureProject(stateDir: string, slug: string): void {
  const now = fixtureProjects(stateDir);
  if (now.includes(slug))
    write(
      stateDir,
      now.filter((s) => s !== slug),
    );
}
