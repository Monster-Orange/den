import * as fs from "fs";
import * as path from "path";

export function logsDump(stateDir: string): string[] {
  const files: string[] = [];
  const walk = (d: string, depth: number) => {
    let names: string[] = [];
    try {
      names = fs.readdirSync(d);
    } catch (e) {
      files.push(`${d}: ${String(e)}`);
      return;
    }
    for (const n of names) {
      const f = path.join(d, n);
      const st = fs.lstatSync(f);
      const kind = st.isSymbolicLink()
        ? "link"
        : st.isDirectory()
          ? "dir"
          : "file";
      files.push(`${(st.mode & 0o7777).toString(8)} ${kind} ${st.size} ${f}`);
      if (st.isDirectory() && depth > 0) walk(f, depth - 1);
    }
  };
  walk(path.join(stateDir, "logs"), 2);
  return files;
}
