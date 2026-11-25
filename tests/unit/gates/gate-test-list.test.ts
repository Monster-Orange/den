import { describe, expect, it } from "@jest/globals";
import { emptyTestList } from "../../../src/ui/cli/gate-test-list.js";

const w = (s: string) => s.split(" ");

describe("gate run: a test run that names no tests", () => {
  it("names the runner that would run every test", () => {
    expect(emptyTestList(w("npx jest --maxWorkers=1"))).toBe("jest");
    expect(emptyTestList(w("jest"))).toBe("jest");
    expect(emptyTestList(w("npx -y jest --maxWorkers 1 --ci"))).toBe("jest");
    expect(
      emptyTestList(w("node node_modules/.bin/jest -c jest.config.js")),
    ).toBe("jest");
    expect(emptyTestList(w("pnpm exec vitest run"))).toBe("vitest");
    expect(emptyTestList(w("npx playwright test --project chromium"))).toBe(
      "playwright",
    );
  });

  it("lets a run through that names files or a filter", () => {
    expect(
      emptyTestList(w("npx jest --maxWorkers=1 tests/a.test.ts")),
    ).toBeNull();
    expect(
      emptyTestList(w("npx jest --maxWorkers 1 tests/a.test.ts")),
    ).toBeNull();
    expect(emptyTestList(w("npx jest --testPathPattern=gates"))).toBeNull();
    expect(emptyTestList(w("npx jest -t stop-ship"))).toBeNull();
    expect(emptyTestList(w("npx jest --findRelatedTests src/a.ts"))).toBeNull();
    expect(emptyTestList(w("vitest run src/a.test.ts"))).toBeNull();
    expect(emptyTestList(w("npx playwright test e2e/a.spec.ts"))).toBeNull();
    expect(emptyTestList(w("npx playwright test --grep @nav"))).toBeNull();
  });

  it("leaves other commands alone", () => {
    expect(emptyTestList(w("npm test"))).toBeNull();
    expect(emptyTestList(w("npx tsc -p ."))).toBeNull();
    expect(emptyTestList(w("npx playwright install chromium"))).toBeNull();
    expect(emptyTestList(w("node scripts/x.mjs"))).toBeNull();
  });
});
