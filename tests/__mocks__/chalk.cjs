// Chalk stub for Jest — returns the string unchanged, enables testing
// modules that import chalk without ESM/CJS interop issues.
//
// Export the proxy directly (no { default: } wrapper) so that TypeScript's
// __importDefault helper produces the correct shape:
//   __importDefault(chalkProxy) → { default: chalkProxy }
// rather than double-wrapping it.
const noop = (s) => String(s ?? "");
const chalk = new Proxy(noop, { get: () => chalk });
module.exports = chalk;
