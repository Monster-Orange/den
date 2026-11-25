/**
 * Issue 989: `workspace create`, `activate`, `deactivate` and `delete` are
 * a person's (an agent asks with the held write workspace_create). They go
 * to the running server, whose request guard is the person check; the
 * server's answer is final. Only with no server listening does the CLI
 * change the projects file itself, and never in an agent's session.
 */
import { isAgentTokenEnv } from "../../shared/actor-token.js";
import { throughServer, type PersonServer } from "./person-server.js";

export type WorkspaceVerb = "create" | "activate" | "deactivate" | "delete";

export type WorkspaceAnswer =
  | { kind: "done"; json: Record<string, unknown> }
  | { kind: "refused"; error: string }
  | { kind: "unanswered" };

/** Why an agent's session can't run `verb`; null for a person. */
export function workspacePersonRefusal(
  verb: WorkspaceVerb,
  env: Record<string, string | undefined> = process.env,
): string | null {
  return isAgentTokenEnv(env)
    ? `Only a person can ${verb} a project (this is an agent; it asks for a new project with a held write)`
    : null;
}

/** `verb` for project `name`, sent to the running server. */
export async function workspaceViaServer(
  verb: WorkspaceVerb,
  name: string,
  server: PersonServer,
): Promise<WorkspaceAnswer> {
  const call =
    verb === "create"
      ? (["POST", "/api/workspaces/create", { name }] as const)
      : verb === "delete"
        ? ([
            "DELETE",
            "/api/workspaces",
            { name, cleanupDirectory: true },
          ] as const)
        : (["POST", "/api/workspaces", { name, action: verb }] as const);
  try {
    const json = await throughServer(server, call[0], call[1], call[2]);
    return json === null ? { kind: "unanswered" } : { kind: "done", json };
  } catch (e) {
    return { kind: "refused", error: (e as Error).message };
  }
}

/**
 * Issue 989: a seed with a reset is a person's, whether by --reset or by
 * the prompt (`willReset`: the blueprint's projects have entries). A seed
 * with nothing to reset is anyone's. Null when it may go on.
 */
export function seedResetRefusal(
  /** `via`: the command that was run, named in the refusal. */
  o: { reset: boolean; willReset: boolean; via: string },
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (!isAgentTokenEnv(env) || (!o.reset && !o.willReset)) return null;
  return `Only a person can reset projects (\`${o.via}\` with a reset); this is an agent, so nothing was changed`;
}

/**
 * Issue 1182: a reset to the blueprint, sent to the running server (POST
 * /api/workspaces/seed, a person's). What it seeded, its refusal, or
 * unanswered when no server listens (the CLI resets as before).
 */
export async function seedResetViaServer(
  server: PersonServer,
): Promise<
  | { kind: "done"; seeded: { name: string; repos: string[] }[] }
  | { kind: "refused"; error: string }
  | { kind: "unanswered" }
> {
  try {
    const json = await throughServer(server, "POST", "/api/workspaces/seed", {
      reset: true,
    });
    if (json === null) return { kind: "unanswered" };
    const seeded = Array.isArray(json.seeded)
      ? (json.seeded as { name: string; repos: string[] }[])
      : [];
    return { kind: "done", seeded };
  } catch (e) {
    return { kind: "refused", error: (e as Error).message };
  }
}
