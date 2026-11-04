// k6/http stub for Jest — k6 modules don't exist outside the Goja runtime.
// We only need imports to resolve; tests of k6 helper modules exercise
// their pure functions without invoking http.post.
// If a test ever calls into k6 APIs it will throw, which is the intended
// signal to either (a) test only the pure helpers from Jest, or
// (b) spin up an integration test that runs under k6 itself.
const notInK6 = () => {
  throw new Error(
    "k6/http is only available in the k6 (Goja) runtime — do not call from Jest tests.",
  );
};
module.exports = {
  post: notInK6,
  get: notInK6,
  request: notInK6,
};
module.exports.default = module.exports;
