/**
 * `den up` planning + classification.
 *
 * Pure discovery: for each node in a derived start-set, resolve HOW den would
 * bring it up (Makefile target / opctl dev op / `.den.yml` override),
 * determine its health signal and container identity, and CLASSIFY it so the up
 * flow can treat the well-behaved majority headlessly while surfacing the few
 * outliers (optional leaves, unconditionally-interactive ups) for a human
 * decision. The same structured plan feeds the CLI (`den up --plan` /
 * pre-flight prompt), the web UX (outline + start toggle), and CI (defaults).
 *
 * Conventions are PRIORS verified here, never trusted blind:
 *   - command:   Makefile `up` is the default; `.den.yml up:` overrides; the
 *                opctl `dev` op is the fallback.
 *   - health:    `.den.yml` health if declared, else `http://<container>/healthz`
 *                (the port-80 + container-name convention).
 *   - optional:  a node nothing else HARD-depends on (only soft/event inbound).
 *   - interactive: the up recipe (or its direct entry script) reaches an
 *                UNCONDITIONAL tab/login/prompt (osascript / `stripe login` /
 *                `read`) that isn't guarded by a TTY / USE_TABS check. (TTY-gated
 *                tabs are safe — den runs without a TTY.)
 */

import * as fs from "fs";
import * as path from "path";
import type { DerivedGraph } from "./derivation/types.js";
import type { ResolvedService } from "../types/index.js";
import { resolveService } from "./service-runner.js";
import { readManifest } from "../manifest/read-manifest.js";
import { effectiveLocalCommands } from "../stacks/manifest-commands.js";
import { getFocusedWorkspaceName } from "./workspaces.js";
import { placementRefusal, servicePlacement } from "../manifest/placement.js";
import { listMakeTargets } from "./make-targets.js";
import { devOpContainerNames } from "./opctl.js";

import { product } from "../product.js";
export type UpFlag = "auto-start off" | "interactive" | "no-command" | "remote";

export interface NodePlan {
  repo: string;
  /** Concrete command den would run for `up`, or null if none was found. */
  upCommand: string | null;
  /** Where the command came from. */
  upSource: "manifest" | "make" | "opctl-dev" | "none";
  /** opctl container names declared by the repo's dev/up op (for down/health). */
  containerNames: string[];
  /** URL den would poll for readiness, or null. */
  healthUrl: string | null;
  /** The user toggled this system's auto-start off in the workspace. */
  noAutostart: boolean;
  /** `up` may open a tab / prompt unattended (not just a one-touch op-signin). */
  interactive: boolean;
  interactiveReason: string;
  /** Short label for the interactivity kind: tabs | stripe | 1pwd | prompt. */
  interactiveKind: string;
  /** What den does by default with no human input (CI / no-TTY). */
  defaultAction: "start" | "skip";
  flags: UpFlag[];
  notes: string[];
}

/**
 * Resolve the up command for a service. Makefile `up` is the default (the
 * discovered convention); a `.den.yml` `up:` override wins when present; the
 * opctl `dev` op is the fallback when there is no make target.
 */
export function resolveUpCommand(svc: ResolvedService): {
  command: string | null;
  source: NodePlan["upSource"];
  overrideAvailable?: string;
} {
  const manifest = readManifest(svc.repoPath);
  const manifestUp = manifest
    ? effectiveLocalCommands(
        manifest,
        svc.subsystem,
        svc.repoName,
        getFocusedWorkspaceName() ?? "default",
      )["up"]
    : undefined;
  // A compose stack is run by den behind the edge, never by `make up`
  // (which would publish host ports).
  if (manifest?.compose && manifestUp) {
    const cmd = typeof manifestUp === "string" ? manifestUp : manifestUp.cmd;
    return { command: cmd, source: "manifest" };
  }
  const manifestUpCmd =
    typeof manifestUp === "string" ? manifestUp : manifestUp?.cmd;

  const hasMakeUp = listMakeTargets(svc.repoPath).targets.includes("up");
  if (hasMakeUp) {
    return {
      command: "make up",
      source: "make",
      ...(manifestUpCmd && manifestUpCmd !== "make up"
        ? { overrideAvailable: manifestUpCmd }
        : {}),
    };
  }
  if (devOpContainerNames(svc.repoPath).length > 0) {
    return { command: "opctl run dev", source: "opctl-dev" };
  }
  if (manifestUpCmd) return { command: manifestUpCmd, source: "manifest" };
  return { command: null, source: "none" };
}

/** The readiness URL: declared `.den.yml` health, else container:80/healthz. */
export function resolveHealthUrl(
  svc: ResolvedService,
  containerNames: string[],
): string | null {
  const manifest = readManifest(svc.repoPath);
  const health = manifest?.services?.[svc.subsystem]?.health?.local as
    | { url?: string; cmd?: string }
    | undefined;
  if (health?.url) return health.url;
  if (containerNames.length > 0) return `http://${containerNames[0]}/healthz`;
  return null;
}

const INTERACTIVE_MARKERS =
  /\bosascript\b|\bstripe\s+(login|listen)\b|\bread\s+-[rp]\b/;
const TTY_GUARD = /-t\s+1\b|USE_TABS|\bCI\b|\[\[\s*-t/;

/**
 * Recipe text for a Makefile target PLUS the recipes of its direct
 * prerequisites (one level). Following prereqs matters because an `up` target is
 * often just an alias — e.g. billing's `up: dev`, where the real (interactive)
 * work lives in the `dev` recipe.
 */
function makeRecipe(
  makefilePath: string,
  target: string,
  seen = new Set<string>(),
): string {
  if (seen.has(target)) return "";
  seen.add(target);
  let text: string;
  try {
    text = fs.readFileSync(makefilePath, "utf-8");
  } catch {
    return "";
  }
  const lines = text.split("\n");
  const recipe: string[] = [];
  const prereqs: string[] = [];
  let capturing = false;
  for (const line of lines) {
    const header = new RegExp(`^${target}:(.*)$`).exec(line);
    if (header) {
      capturing = true;
      // Prerequisite targets are the space-separated tokens after the colon
      // (drop ## comments and inline vars).
      for (const tok of header[1].replace(/##.*/, "").trim().split(/\s+/)) {
        if (tok && /^[\w.-]+$/.test(tok)) prereqs.push(tok);
      }
      continue;
    }
    if (capturing) {
      if (line.startsWith("\t") || line.trim() === "") recipe.push(line);
      else capturing = false; // next rule starts
    }
  }
  const prereqRecipes = prereqs.map((p) => makeRecipe(makefilePath, p, seen));
  return [recipe.join("\n"), ...prereqRecipes].join("\n");
}

/** Scripts the recipe directly invokes (one level — not transitive). */
function entryScripts(recipe: string, repoPath: string): string[] {
  const out: string[] = [];
  for (const m of recipe.matchAll(/(?:\.\/)?([\w./-]+\.sh)\b/g)) {
    const rel = m[1].replace(/^\.\//, "");
    const abs = path.join(repoPath, rel);
    if (fs.existsSync(abs)) out.push(abs);
  }
  return out;
}

/**
 * Whether `up` reaches an UNCONDITIONAL interactive tab/login/prompt. We scan
 * the recipe and its DIRECT entry scripts only (not transitively): an
 * interactive marker one level deeper, behind a TTY/USE_TABS gate (e.g. scribe's
 * run_in_tab.sh), is safe because den runs without a TTY — only inline,
 * unguarded markers (e.g. billing's `osascript` in the recipe itself) count.
 */
/** A short label for the kind of interactivity (for inline plan tags). */
function interactiveKindOf(hit: string): string {
  if (/osascript|new tab/i.test(hit)) return "tabs";
  if (/stripe/i.test(hit)) return "stripe";
  if (/op\s+signin/i.test(hit)) return "1pwd";
  return "prompt";
}

export function classifyInteractive(
  svc: ResolvedService,
  upCommand: string | null,
): { interactive: boolean; reason: string; kind: string } {
  if (!upCommand) return { interactive: false, reason: "", kind: "" };

  const makeTarget = upCommand.match(/^make\s+([\w-]+)/)?.[1];
  const sources: { label: string; content: string }[] = [];
  if (makeTarget) {
    const recipe = makeRecipe(path.join(svc.repoPath, "Makefile"), makeTarget);
    sources.push({ label: `Makefile:${makeTarget}`, content: recipe });
    for (const script of entryScripts(recipe, svc.repoPath)) {
      try {
        sources.push({
          label: path.relative(svc.repoPath, script),
          content: fs.readFileSync(script, "utf-8"),
        });
      } catch {
        /* unreadable — skip */
      }
    }
  }

  for (const s of sources) {
    if (INTERACTIVE_MARKERS.test(s.content) && !TTY_GUARD.test(s.content)) {
      const hit = s.content.match(INTERACTIVE_MARKERS)?.[0] ?? "prompt";
      return {
        interactive: true,
        reason: `${s.label} runs an unguarded ${hit.trim()}`,
        kind: interactiveKindOf(hit),
      };
    }
  }
  return { interactive: false, reason: "", kind: "" };
}

export interface UpPlanOptions {
  /**
   * Repos whose auto-start is toggled OFF in the workspace (`autostart: false`
   * on the service entry). Not derivable from the graph — a node with only soft
   * inbound edges is usually still a dependency you want — so it's declared
   * per workspace, not guessed.
   */
  noAutostart?: Set<string>;
}

/** Build the per-node plan for an ordered start-set over a derived graph. */
export function buildUpPlan(
  graph: DerivedGraph,
  order: string[],
  opts: UpPlanOptions = {},
): NodePlan[] {
  const noAutostartSet = opts.noAutostart ?? new Set<string>();
  void graph; // reserved for future graph-derived hints (leaf candidates, etc.)
  return order.map((repo) => {
    const svc = resolveService(repo);
    const notes: string[] = [];
    if (!svc) {
      return {
        repo,
        upCommand: null,
        upSource: "none",
        containerNames: [],
        healthUrl: null,
        noAutostart: noAutostartSet.has(repo),
        interactive: false,
        interactiveReason: "",
        interactiveKind: "",
        defaultAction: "skip",
        flags: ["no-command"],
        notes: ["not resolvable in the workspace"],
      };
    }

    // R13: a remote service is never started, whatever its Makefile says.
    const remote = placementRefusal(
      svc.address,
      servicePlacement(readManifest(svc.repoPath), svc.subsystem, "local"),
      () => false,
    );
    if (remote) {
      return {
        repo,
        upCommand: null,
        upSource: "none",
        containerNames: [],
        healthUrl: null,
        noAutostart: noAutostartSet.has(repo),
        interactive: false,
        interactiveReason: "",
        interactiveKind: "",
        defaultAction: "skip",
        flags: ["remote"],
        notes: [remote],
      };
    }

    const { command, source, overrideAvailable } = resolveUpCommand(svc);
    if (overrideAvailable) {
      notes.push(
        `${product().manifestYml} up override available: ${overrideAvailable}`,
      );
    }
    const containerNames = devOpContainerNames(svc.repoPath);
    const healthUrl = resolveHealthUrl(svc, containerNames);
    const noAutostart = noAutostartSet.has(repo);
    const { interactive, reason, kind } = classifyInteractive(svc, command);

    const flags: UpFlag[] = [];
    if (noAutostart) flags.push("auto-start off");
    if (interactive) flags.push("interactive");
    if (!command) flags.push("no-command");

    // No human input (CI / no-TTY): skip flagged nodes, start the rest.
    const defaultAction: NodePlan["defaultAction"] =
      noAutostart || interactive || !command ? "skip" : "start";

    return {
      repo,
      upCommand: command,
      upSource: source,
      containerNames,
      healthUrl,
      noAutostart,
      interactive,
      interactiveReason: reason,
      interactiveKind: kind,
      defaultAction,
      flags,
      notes,
    };
  });
}
