import base from "./jest.config.js";

export default {
  ...base,
  testMatch: ["**/tests/load/**/*.load.ts"],
  testPathIgnorePatterns: ["/node_modules/"],
  collectCoverage: false,
  coverageThreshold: undefined,
  maxWorkers: 1,
};
