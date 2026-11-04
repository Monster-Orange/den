// Inquirer stub for Jest — no interactive prompts needed in unit tests.
// Exposes `prompt` both nested under `default` and top-level: depending on
// interop, `import inquirer from "inquirer"` can resolve to either shape.
const prompt = async () => ({});
module.exports = { default: { prompt }, prompt };
