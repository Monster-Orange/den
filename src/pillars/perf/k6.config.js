/**
 * k6 Configuration
 * Base configuration for performance tests
 */

export const options = {
  // VUs (Virtual Users)
  vus: 10,
  duration: "30s",

  // Thresholds - Define SLAs
  thresholds: {
    // 95% of requests should be below 500ms
    http_req_duration: ["p(95)<500"],

    // Error rate should be less than 1%
    http_req_failed: ["rate<0.01"],

    // 90% of requests should be below 300ms
    "http_req_duration{name:health}": ["p(90)<300"],
  },

  // Stages for ramping VUs
  stages: [
    { duration: "30s", target: 20 }, // Ramp up to 20 users
    { duration: "1m", target: 20 }, // Stay at 20 users
    { duration: "30s", target: 0 }, // Ramp down to 0 users
  ],

  // Tags - For organizing metrics
  tags: {
    test_type: "load",
  },

  // Summaries
  summaryTrendStats: ["avg", "min", "med", "max", "p(90)", "p(95)", "p(99)"],

  // HTTP settings
  http: {
    timeout: "30s",
  },

  // Rate limiting
  // rps: 100, // Max requests per second

  // Scenarios - Advanced load patterns
  scenarios: {
    // Constant load
    constant_load: {
      executor: "constant-vus",
      vus: 10,
      duration: "1m",
      tags: { scenario: "constant" },
    },

    // Ramping load
    ramping_load: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "30s", target: 50 },
        { duration: "1m", target: 50 },
        { duration: "30s", target: 0 },
      ],
      tags: { scenario: "ramping" },
    },

    // Per-VU iterations
    // per_vu_iterations: {
    //   executor: 'per-vu-iterations',
    //   vus: 10,
    //   iterations: 100,
    //   maxDuration: '5m',
    //   tags: { scenario: 'iterations' },
    // },

    // Constant arrival rate
    // constant_arrival_rate: {
    //   executor: 'constant-arrival-rate',
    //   rate: 100, // 100 iterations per timeUnit
    //   timeUnit: '1s',
    //   duration: '1m',
    //   preAllocatedVUs: 50,
    //   maxVUs: 100,
    //   tags: { scenario: 'arrival' },
    // },
  },
};

/**
 * Load environment configuration
 */
export function getEnvironment() {
  const env = __ENV.E2E_ENVIRONMENT || "local";
  const configPath = `./config/environments/${env}.json`;

  // In k6, we need to read config from environment variables
  // since k6 doesn't support direct file reading in init context
  return {
    name: env,
    baseUrl: __ENV.API_BASE_URL || "http://localhost:3000",
    apiTimeout: parseInt(__ENV.API_TIMEOUT || "30000", 10),
  };
}

/**
 * Get authentication token
 * Note: In real tests, you'd get this via OAuth flow or from ENV
 */
export function getAuthToken() {
  return __ENV.AUTH_TOKEN || "";
}
