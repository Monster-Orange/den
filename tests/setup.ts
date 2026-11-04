/**
 * Jest setup file
 * Runs before each test suite
 */

// Set test environment
process.env.NODE_ENV = "test";

// Tests run as Den's own profile (den.yml at the checkout root).

// Increase test timeout for integration tests
jest.setTimeout(10000);

// Mock console methods to reduce noise in tests
global.console = {
  ...console,
  // Keep log for debugging but silence in CI
  log: process.env.CI ? jest.fn() : console.log,
  debug: jest.fn(),
  // Keep error and warn for important messages
  error: console.error,
  warn: console.warn,
};

// Global test utilities
export {};
