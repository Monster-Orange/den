/**
 * Issue 786 clause 4: `<cli> layout` puts a broken layout back from one of
 * the rolling snapshots (src/shared/layout-snapshots.ts).
 *
 *   <cli> layout snapshots         the snapshots, newest first
 *   <cli> layout restore [<id>]    put one back (default: the newest that
 *                                  differs from the layout now)
 *
 * A restore takes a snapshot of the layout it replaces first (ignoring the
 * 15-minute gap), so a restore can itself be undone. The page reads the
 * layout from user.yml at its next load.
 */
import {
  listLayoutSnapshots,
  snapshotLayout,
} from "../../shared/layout-snapshots.js";
import { getStateDir } from "../../shared/paths.js";
import { readUserConfig, writeUserConfig } from "../../shared/den-config.js";
import { product } from "../../shared/product.js";

export interface LayoutDeps {
  stateDir: () => string;
  readShell: () => unknown;
  writeShell: (shell: unknown) => void;
  out: (line: string) => void;
  err: (line: string) => void;
  now: () => Date;
  cli: () => string;
}

const defaults = (): LayoutDeps => ({
  stateDir: getStateDir,
  readShell: () => readUserConfig().shell,
  writeShell: (shell) => {
    const u = readUserConfig();
    if (shell === undefined || shell === null) delete u.shell;
    else u.shell = shell as typeof u.shell;
    writeUserConfig(u);
  },
  out: (l) => console.log(l),
  err: (l) => console.error(l),
  now: () => new Date(),
  cli: () => product().cli,
});

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** What a snapshot holds, in a few words. */
function summary(shell: unknown): string {
  if (!shell || typeof shell !== "object") return "the default layout";
  const s = shell as {
    pins?: unknown[];
    hidden?: unknown[];
    collapsed?: boolean;
  };
  const parts = [
    `${Array.isArray(s.pins) ? s.pins.length : 0} pinned`,
    `${Array.isArray(s.hidden) ? s.hidden.length : 0} hidden`,
  ];
  if (s.collapsed) parts.push("rail collapsed");
  return parts.join(", ");
}

export function cmdLayout(
  args: readonly string[],
  over: Partial<LayoutDeps> = {},
): number {
  const d = { ...defaults(), ...over };
  const [sub, id] = args;
  const dir = d.stateDir();
  if (sub === "snapshots" || sub === "list") {
    const all = listLayoutSnapshots(dir);
    if (!all.length) {
      d.out("No layout snapshots yet: one is taken when the layout changes.");
      return 0;
    }
    for (const s of all) d.out(`  ${s.id}  ${summary(s.shell)}`);
    d.out(`Put one back: ${d.cli()} layout restore <id>`);
    return 0;
  }
  if (sub === "restore") {
    const now = d.readShell();
    const all = listLayoutSnapshots(dir);
    const pick = id
      ? all.find((s) => s.id === id)
      : all.find((s) => !same(s.shell, now));
    if (!pick) {
      d.err(
        id
          ? `No layout snapshot ${id}: \`${d.cli()} layout snapshots\` lists them.`
          : "No layout snapshot differs from the layout now.",
      );
      return 1;
    }
    snapshotLayout(dir, now, d.now(), { minGapMs: 0 });
    d.writeShell(pick.shell);
    d.out(
      `Layout put back from ${pick.id} (${summary(pick.shell)}). Reload the page to see it.`,
    );
    return 0;
  }
  d.err(
    `Usage: ${d.cli()} layout snapshots | ${d.cli()} layout restore [<id>]`,
  );
  return 2;
}
