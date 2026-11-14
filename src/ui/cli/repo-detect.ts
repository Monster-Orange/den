/**
 * `repo add`'s detection: how a repo runs, read from its own files, so Den
 * can write a side-car manifest for it without a commit to the repo.
 *
 * Read-only and pure apart from reading files: nothing here writes, spawns
 * or runs the repo's tools. The rules, in order:
 *
 * 1. A Makefile with an `up` target (init's detection, listMakeTargets):
 *    `make up`, plus `down`, `setup` and `restart` when present, and a
 *    `test` target as the repo's test suite.
 * 2. Otherwise each other way to start it is a candidate: a compose file
 *    (`docker compose -f <file> up -d`, down with `down`), and package.json's
 *    `dev` or else `start` script (`npm run dev`, `npm start`). Exactly one
 *    candidate decides; more than one, or none, is a question for the
 *    person, with the candidates as choices. Nothing is written until a
 *    re-run names one (`--run "<cmd>"`).
 * 3. package.json's `test` script (or a Makefile `test`) is the test suite.
 *
 * `--run "<cmd>"` overrides 1 and 2: that command is `up`.
 */
import * as fs from "fs";
import * as path from "path";
import { listMakeTargets } from "../../shared/environment-manager/make-targets.js";

/** Compose files Docker looks for, in its own order. */
export const COMPOSE_FILES = [
  "compose.yaml",
  "compose.yml",
  "docker-compose.yaml",
  "docker-compose.yml",
] as const;

export interface DetectedCommands {
  /** Where the commands came from. */
  source: "make" | "compose" | "package.json" | "--run";
  up: string;
  down?: string;
  setup?: string;
  restart?: string;
  /** The repo's own test command, when it has one. */
  test?: string;
  /** The compose file, when the repo has one. */
  composeFile?: string;
}

export type Detection =
  | { decided: true; commands: DetectedCommands }
  | {
      decided: false;
      /** A question for the person. */
      ask: string;
      /** Start commands to choose from (may be empty). */
      choices: string[];
    };

function readScripts(repoPath: string): Record<string, string> {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(repoPath, "package.json"), "utf-8"),
    ) as { scripts?: Record<string, unknown> };
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(pkg.scripts ?? {}))
      if (typeof v === "string") out[k] = v;
    return out;
  } catch {
    return {};
  }
}

/** The compose file at the repo root, or undefined. */
export function composeFileOf(repoPath: string): string | undefined {
  return COMPOSE_FILES.find((f) => fs.existsSync(path.join(repoPath, f)));
}

/** How `repoPath` runs, or the question to ask. See the module comment. */
export function detectRunCommands(
  repoPath: string,
  opts: { run?: string; down?: string } = {},
): Detection {
  const make = new Set(listMakeTargets(repoPath).targets);
  const scripts = readScripts(repoPath);
  const composeFile = composeFileOf(repoPath);
  const test = make.has("test")
    ? "make test"
    : scripts.test && !/no test specified/.test(scripts.test)
      ? "npm test"
      : undefined;
  const withExtras = (c: DetectedCommands): DetectedCommands => ({
    ...c,
    ...(test ? { test } : {}),
    ...(composeFile ? { composeFile } : {}),
  });

  if (opts.run?.trim()) {
    return {
      decided: true,
      commands: withExtras({
        source: "--run",
        up: opts.run.trim(),
        ...(opts.down?.trim()
          ? { down: opts.down.trim() }
          : make.has("down")
            ? { down: "make down" }
            : {}),
      }),
    };
  }

  if (make.has("up")) {
    const c: DetectedCommands = { source: "make", up: "make up" };
    for (const t of ["down", "setup", "restart"] as const)
      if (make.has(t)) c[t] = `make ${t}`;
    return { decided: true, commands: withExtras(c) };
  }

  const candidates: DetectedCommands[] = [];
  if (composeFile)
    candidates.push({
      source: "compose",
      up: `docker compose -f ${composeFile} up -d`,
      down: `docker compose -f ${composeFile} down`,
    });
  if (scripts.dev)
    candidates.push({ source: "package.json", up: "npm run dev" });
  else if (scripts.start)
    candidates.push({ source: "package.json", up: "npm start" });

  if (candidates.length === 1)
    return { decided: true, commands: withExtras(candidates[0]) };
  const choices = candidates.map((c) => c.up);
  return {
    decided: false,
    ask:
      choices.length > 0
        ? `This repo can start in ${choices.length} ways. Which one do you use to run it locally?`
        : "How do you usually start this repo locally? (the command you type in its folder)",
    choices,
  };
}

/** Whether a repo's commands or files say it needs Docker. */
export function needsDocker(manifest: unknown, repoPath?: string): boolean {
  const m = (manifest ?? {}) as {
    compose?: unknown;
    services?: Record<string, { commands?: Record<string, unknown> }>;
  };
  if (m.compose) return true;
  for (const svc of Object.values(m.services ?? {}))
    for (const env of Object.values(svc?.commands ?? {}))
      for (const cmd of Object.values((env ?? {}) as Record<string, unknown>)) {
        const text =
          typeof cmd === "string"
            ? cmd
            : ((cmd as { cmd?: string } | null)?.cmd ?? "");
        if (/\bdocker(-compose)?\b/.test(text)) return true;
      }
  return repoPath ? composeFileOf(repoPath) !== undefined : false;
}

/**
 * Dev servers' own default ports, by the command a package script runs.
 * Only tools whose default is fixed and documented; anything else gets no
 * port, and so no health URL.
 */
const DEV_SERVER_PORTS: ReadonlyArray<[RegExp, number]> = [
  [/^next(\s+dev)?\b/, 3000],
  [/^(vite|vite\s+dev|vite\s+serve)\b/, 5173],
  [/^(nuxt|nuxi)\s+dev\b/, 3000],
  [/^react-scripts\s+start\b/, 3000],
  [/^ng\s+serve\b/, 4200],
  [/^gatsby\s+develop\b/, 8000],
  [/^remix\s+vite:dev\b/, 5173],
  [/^webpack(-dev-server|\s+serve)\b/, 8080],
];

/** A port the command names itself: --port N, -p N, PORT=N. */
function explicitPort(cmd: string): number | undefined {
  const m =
    /(?:^|\s)--port[=\s]+(\d{2,5})\b/.exec(cmd) ??
    /(?:^|\s)-p\s+(\d{2,5})\b/.exec(cmd) ??
    /(?:^|\s)PORT=(\d{2,5})\b/.exec(cmd);
  const n = m ? Number(m[1]) : NaN;
  return n > 0 && n < 65536 ? n : undefined;
}

/**
 * The port a repo's dev server listens on, when its start command is a
 * package script that names one or runs a dev server with a known default.
 * Read-only: the script's text, never the running server.
 */
export function detectDevPort(
  repoPath: string,
  c: Pick<DetectedCommands, "up">,
): number | undefined {
  const scripts = readScripts(repoPath);
  const m = /^npm\s+(?:run\s+(\S+)|(start))$/.exec(c.up.trim());
  const script = m ? scripts[m[1] ?? "start"] : c.up;
  if (!script) return undefined;
  const own = explicitPort(script);
  if (own) return own;
  // The tool the script runs, after any VAR=value prefixes and npx.
  const tool = script
    .trim()
    .replace(/^(?:[A-Z_][A-Z0-9_]*=\S*\s+)+/, "")
    .replace(/^npx\s+(?:--yes\s+)?/, "");
  return DEV_SERVER_PORTS.find(([re]) => re.test(tool))?.[1];
}

/** The health URL to draft: the dev server's own port, at `/`. */
export function draftHealthUrl(
  repoPath: string,
  c: Pick<DetectedCommands, "up">,
): string | undefined {
  const port = detectDevPort(repoPath, c);
  // eslint-disable-next-line no-restricted-syntax -- a repo's own dev server, as its config names it, not Den's
  return port ? `http://localhost:${port}/` : undefined;
}

/** The side-car manifest for a repo Den detected. Validate before writing. */
export function sidecarManifest(
  name: string,
  c: DetectedCommands,
  health?: string,
): Record<string, unknown> {
  const local: Record<string, string> = { up: c.up };
  if (c.down) local.down = c.down;
  if (c.setup) local.setup = c.setup;
  if (c.restart) local.restart = c.restart;
  return {
    version: 1,
    name,
    services: {
      [name]: {
        commands: { local },
        ...(health ? { health: { local: { url: health } } } : {}),
      },
    },
    ...(c.test ? { tests: { unit: { cmd: c.test } } } : {}),
  };
}

/** A repo name Den can use as a key: the folder or URL's last segment. */
export function repoNameFrom(spec: string): string {
  const leaf =
    spec
      .replace(/[/\\]+$/, "")
      .replace(/\.git$/, "")
      .split(/[/:\\]/)
      .pop() ?? "";
  return leaf;
}
