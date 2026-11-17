#!/usr/bin/env node
/**
 * Checks each live check in a folder (default: gate/) has the shape the bed
 * harness loads (CONTRIBUTING.md, "Live checks"):
 *
 *   gate/<issue>.mjs exports
 *     issue     the issue number, the same as the file name
 *     clauses   the issue's clauses it proves, by name (non-empty)
 *     setup(ctx)            prepares the bed, returns state
 *     run(ctx, state)       acts through ctx.url (HTTP or a browser page)
 *                           and ctx.cli(args); returns what it saw
 *     expect(result)        [{ clause, ok, detail? }], one per clause
 *
 * Prints a JSON array of problems (empty when all is well); exits 1 when
 * there are any. Loads each file, so a file that throws on import counts.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

export function checkGateModule(file, mod) {
  const out = [];
  const m = /^(\d+)\.mjs$/.exec(file);
  if (!m) return [`${file}: the name is not <issue number>.mjs`];
  if (mod.issue !== Number(m[1]))
    out.push(`${file}: issue is ${mod.issue}, the file name says ${m[1]}`);
  if (!Array.isArray(mod.clauses) || mod.clauses.length === 0)
    out.push(`${file}: clauses is empty (name each clause it proves)`);
  for (const fn of ["setup", "run", "expect"])
    if (typeof mod[fn] !== "function")
      out.push(`${file}: ${fn} is not a function`);
  return out;
}

export async function checkGateDir(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".mjs"))
    .sort()) {
    try {
      out.push(
        ...checkGateModule(
          f,
          await import(pathToFileURL(path.resolve(dir, f)).href),
        ),
      );
    } catch (e) {
      out.push(
        `${f}: does not load (${String(e?.message ?? e).split("\n")[0]})`,
      );
    }
  }
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const problems = await checkGateDir(process.argv[2] ?? "gate");
  console.log(JSON.stringify(problems));
  process.exit(problems.length ? 1 : 0);
}
