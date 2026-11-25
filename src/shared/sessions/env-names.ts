/**
 * The variable that names the agent a session runs (DEN_AGENT), in a
 * module that imports nothing: the test setup reads it, and a module it
 * loads early is loaded with the real fs, ahead of any suite's
 * jest.mock("fs") (issue 786).
 */
export const AGENT_ACTOR_ENV = "DEN_AGENT";
