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

  it("judges npm, pnpm and yarn test by the script they run", () => {
    const scripts: Record<string, string> = {
      test: "jest",
      "test:unit": "cross-env NODE_ENV=test jest --ci",
      "test:named": "jest tests/unit",
      "test:chain": "tsc && jest",
    };
    const s = (n: string) => scripts[n];
    expect(emptyTestList(w("npm test"), s)).toBe("jest");
    expect(emptyTestList(w("npm run test:unit"), s)).toBe("jest");
    expect(emptyTestList(w("yarn test:unit"), s)).toBe("jest");
    expect(emptyTestList(w("pnpm test"), s)).toBe("jest");
    expect(emptyTestList(w("npm test -- tests/a.test.ts"), s)).toBeNull();
    expect(emptyTestList(w("npm run test:named"), s)).toBeNull();
    expect(emptyTestList(w("npm run test:chain"), s)).toBeNull();
    expect(emptyTestList(w("npm run build"), s)).toBeNull();
    expect(emptyTestList(w("npm test"), () => undefined)).toBeNull();
  });

  it("steps over npx's package flag", () => {
    expect(emptyTestList(w("npx -p jest jest"))).toBe("jest");
    expect(emptyTestList(w("npx --package jest jest a.test.ts"))).toBeNull();
  });

  it("leaves other commands alone", () => {
    expect(emptyTestList(w("npm test"))).toBeNull();
    expect(emptyTestList(w("npx tsc -p ."))).toBeNull();
    expect(emptyTestList(w("npx playwright install chromium"))).toBeNull();
    expect(emptyTestList(w("node scripts/x.mjs"))).toBeNull();
  });
});
