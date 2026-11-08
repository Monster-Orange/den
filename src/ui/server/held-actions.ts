/**
 * The writes ON-3 holds for the person (approval-routes.ts): each one's
 * check (the args turned into Den's own words, bad args refused before
 * anything waits) and its run. The runs are the existing code paths, not
 * copies:
 *
 *   workspace_create  the Workspaces page's create (workspaceCreateRefusal,
 *                     createWorkspace)
 *   repo_add          `repo add --json` (repo-command.ts repoAdd), a local
 *                     folder inside home only, as manifest_draft reads; its
 *                     dry run is the Review
 *   service_try       `up` through the service runner, as
 *                     /api/service/exec and service_up run it
 *                     (lifecycle-exec.ts), until it is ready or exits
 */
import * as path from "path";
import { checkOnboardPath, type PathRules } from "../cli/onboard-reads.js";
import {
  repoAdd,
  type ManifestValidator,
  type RepoAddResult,
} from "../cli/repo-command.js";
import type { HeldAction, HeldActions, HeldCheck } from "./approval-routes.js";

export interface TryResult {
  ok: boolean;
  exitCode: number | null;
  /** Started and healthy (or, with no check, still running). */
  ready: boolean;
  lines: string[];
}

export interface HeldActionDeps {
  rules: () => PathRules;
  validate: ManifestValidator;
  workspaceCreateRefusal: (name: string | undefined) => string | null;
  createWorkspace: (name: string) => void;
  workspaceExists: (name: string) => boolean;
  /** Where `repo add` puts a repo with no -w: the focused one, else `default`. */
  defaultWorkspace: () => string;
  /** The service `up` would start, or why it can't (the exec route's checks). */
  serviceTarget: (
    service: string,
    workspace?: string,
  ) => { ok: true; address: string } | { ok: false; error: string };
  tryService: (address: string, workspace?: string) => Promise<TryResult>;
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

/** A path as the person reads it: ~/… inside home. */
function shown(p: string, home: string): string {
  const rel = path.relative(home, p);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel)
    ? `~/${rel}`
    : rel === ""
      ? "~"
      : p;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** A refusal from a dry run, with its question and choices when it asks. */
function draftError(r: RepoAddResult): string {
  return [
    r.error ?? "repo add can't add it",
    r.ask ? `Ask the person: ${r.ask}` : "",
    r.choices?.length ? `Choices: ${r.choices.join(" | ")}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function heldActions(d: HeldActionDeps): HeldActions {
  const workspaceCreate: HeldAction = {
    check(a): HeldCheck {
      const name = str(a.name);
      const refusal = d.workspaceCreateRefusal(name);
      if (refusal || !name)
        return { ok: false, error: refusal ?? "name required" };
      return {
        ok: true,
        args: { name },
        summary: `create the workspace "${name}"`,
        params: { name },
        details: [`A new, empty workspace named "${name}".`],
      };
    },
    async run(a) {
      const name = String(a.name);
      d.createWorkspace(name);
      return { ok: true, name };
    },
  };

  const repoAddHeld: HeldAction = {
    check(a): HeldCheck {
      const rules = d.rules();
      const where = checkOnboardPath(str(a.path), rules);
      if (!where.ok) return { ok: false, error: where.error };
      const workspace = str(a.workspace);
      if (workspace !== undefined && !NAME_RE.test(workspace))
        return {
          ok: false,
          error: `workspace "${workspace}" must use only letters, digits, ".", "_" and "-"`,
        };
      const opts = {
        name: str(a.name),
        run: str(a.run),
        down: str(a.down),
        health: str(a.health),
      };
      const draft = repoAdd(
        { spec: where.dir, sidecar: false, json: true, dryRun: true, ...opts },
        d.validate,
        where.dir,
      );
      if (!draft.ok) return { ok: false, error: draftError(draft) };
      const ws = workspace ?? d.defaultWorkspace();
      const isNew = !d.workspaceExists(ws);
      const folder = shown(where.dir, rules.home);
      const details = [
        `Folder: ${folder} (your checkout; Den never changes the repo).`,
        `Workspace: ${ws}${isNew ? " (new)" : ""}.`,
        draft.manifest?.source === "repo"
          ? `Manifest: the repo's own (${path.basename(draft.manifest.file)}).`
          : `Manifest: a side-car Den writes in this distribution's manifests/ folder${draft.manifest?.file ? ` (${path.basename(draft.manifest.file)})` : ""}:`,
        ...(draft.draft
          ? draft.draft
              .replace(/\n$/, "")
              .split("\n")
              .map((l) => `  ${l}`)
          : []),
        ...(draft.services?.length
          ? [`Services: ${draft.services.join(", ")}.`]
          : []),
      ];
      return {
        ok: true,
        args: {
          path: where.dir,
          ...(workspace ? { workspace } : {}),
          ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v)),
        },
        summary: `add the repo at ${folder} to workspace "${ws}"${isNew ? " (new)" : ""}`,
        params: {
          path: folder,
          workspace: ws,
          ...(isNew ? { isNew: "1" } : {}),
        },
        details,
      };
    },
    async run(a) {
      const dir = String(a.path);
      return repoAdd(
        {
          spec: dir,
          sidecar: false,
          json: true,
          workspace: str(a.workspace),
          name: str(a.name),
          run: str(a.run),
          down: str(a.down),
          health: str(a.health),
        },
        d.validate,
        dir,
      );
    },
  };

  const serviceTry: HeldAction = {
    check(a): HeldCheck {
      const service = str(a.service);
      if (!service)
        return { ok: false, error: "give service: <repo> or <repo>/<service>" };
      const workspace = str(a.workspace);
      const t = d.serviceTarget(service, workspace);
      if (!t.ok) return { ok: false, error: t.error };
      return {
        ok: true,
        args: { service: t.address, ...(workspace ? { workspace } : {}) },
        summary: `start ${t.address}${workspace ? ` in workspace "${workspace}"` : ""}`,
        params: { service: t.address, ...(workspace ? { workspace } : {}) },
        details: [
          `Runs the service's local "up", as the Services page's Start does.`,
          `Den reports the exit code and the last lines of its output.`,
        ],
      };
    },
    async run(a) {
      return d.tryService(String(a.service), str(a.workspace));
    },
  };

  return {
    workspace_create: workspaceCreate,
    repo_add: repoAddHeld,
    service_try: serviceTry,
  };
}
