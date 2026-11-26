import { afterAll } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export function tempDirs(): (prefix: string) => string {
  const made: string[] = [];
  afterAll(() => {
    for (const d of made.splice(0))
      fs.rmSync(d, { recursive: true, force: true });
  });
  return (prefix) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    made.push(d);
    return d;
  };
}
