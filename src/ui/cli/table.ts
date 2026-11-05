/**
 * cli-table3 colours its borders (grey) and head cells (its own default, or
 * the `style` given) through @colors/colors, which ignores Den's colour
 * detection: piped `status` output carried ANSI codes from the table alone.
 * Every CLI table goes through here, and takes no colour when chalk has none
 * (not a TTY, NO_COLOR, FORCE_COLOR=0).
 */
import chalk from "chalk";
import Table from "cli-table3";

export function newTable(
  opts: Table.TableConstructorOptions = {},
  colour: boolean = chalk.level > 0,
): Table.Table {
  if (colour) return new Table(opts);
  return new Table({
    ...opts,
    style: { ...(opts.style ?? {}), head: [], border: [] },
  });
}
