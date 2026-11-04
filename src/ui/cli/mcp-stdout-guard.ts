/**
 * Imported first by the `mcp` entry: stdout carries the MCP protocol only,
 * so anything that logs through console goes to stderr instead.
 */
const toStderr = (...args: unknown[]): void => console.error(...args);
console.log = toStderr;
console.info = toStderr;
console.debug = toStderr;

export {};
