/**
 * Load Test Scenarios
 * Different load patterns for various testing needs
 */

/**
 * Baseline Load Test
 * Constant load to establish performance baseline
 */
export const baselineLoad = {
  executor: "constant-vus",
  vus: 10,
  duration: "2m",
  tags: { test_type: "baseline" },
};

/**
 * Stress Test
 * Gradually increase load to find breaking point
 */
export const stressTest = {
  executor: "ramping-vus",
  startVUs: 0,
  stages: [
    { duration: "2m", target: 50 }, // Ramp up to 50
    { duration: "5m", target: 100 }, // Ramp up to 100
    { duration: "2m", target: 200 }, // Ramp up to 200
    { duration: "5m", target: 200 }, // Stay at 200
    { duration: "2m", target: 0 }, // Ramp down
  ],
  tags: { test_type: "stress" },
};

/**
 * Spike Test
 * Sudden spike in traffic
 */
export const spikeTest = {
  executor: "ramping-vus",
  startVUs: 0,
  stages: [
    { duration: "30s", target: 10 }, // Normal load
    { duration: "10s", target: 200 }, // Spike!
    { duration: "1m", target: 200 }, // Sustain spike
    { duration: "10s", target: 10 }, // Back to normal
    { duration: "30s", target: 10 }, // Stay at normal
    { duration: "10s", target: 0 }, // Ramp down
  ],
  tags: { test_type: "spike" },
};

/**
 * Soak Test (Endurance Test)
 * Sustained load over extended period
 */
export const soakTest = {
  executor: "constant-vus",
  vus: 50,
  duration: "30m", // Run for 30 minutes
  tags: { test_type: "soak" },
};

/**
 * Breakpoint Test
 * Incrementally increase load until system breaks
 */
export const breakpointTest = {
  executor: "ramping-arrival-rate",
  startRate: 10,
  timeUnit: "1s",
  preAllocatedVUs: 50,
  maxVUs: 500,
  stages: [
    { duration: "1m", target: 10 },
    { duration: "1m", target: 20 },
    { duration: "1m", target: 40 },
    { duration: "1m", target: 80 },
    { duration: "1m", target: 160 },
    { duration: "1m", target: 320 },
  ],
  tags: { test_type: "breakpoint" },
};

/**
 * Peak Traffic Test
 * Simulate peak business hours
 */
export const peakTrafficTest = {
  executor: "ramping-vus",
  startVUs: 0,
  stages: [
    { duration: "5m", target: 100 }, // Morning ramp up
    { duration: "15m", target: 100 }, // Peak hours
    { duration: "5m", target: 0 }, // Ramp down
  ],
  tags: { test_type: "peak" },
};
