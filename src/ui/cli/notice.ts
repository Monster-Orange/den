/**
 * Lines runServiceCommand says that must stay on screen (0.3.0-dev.39, a
 * consumer's dev.38 finding): what Den did with a record from before
 * 0.3.0-dev.37 or with a taken port (adopted, dropped, busy). The CLI's
 * spinner shows other lines only in passing.
 */
import chalk from "chalk";

export function isNotice(line: string): boolean {
  return /^(Warning: |adopted )/.test(line.trim());
}

export function printNotice(line: string): void {
  const l = line.trim();
  console.log(
    l.startsWith("Warning: ")
      ? chalk.yellow(`  ⚠ ${l.slice("Warning: ".length)}`)
      : chalk.gray(`  • ${l}`),
  );
}
