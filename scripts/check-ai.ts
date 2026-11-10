import { createBedrockClient } from "../packages/ai/src/bedrock";
import { loadConfig } from "../packages/core/src/config";

/**
 * `pnpm check:ai`: sends one tiny request to each configured model and says
 * whether AWS accepted it. Prints model ids and AWS's error text, never keys.
 */
try {
  process.loadEnvFile(".env");
} catch {
  // no .env: use real environment variables
}

const { aws } = loadConfig();
const ai = createBedrockClient(aws);
const tasks: [label: string, job: string, model: string][] = [
  ["drafts", "reply-draft", aws.models.default],
  ["classification", "classify", aws.models.classify],
];

let failed = false;
console.log(`Region: ${aws.region}`);
for (const [label, job, model] of tasks) {
  try {
    const result = await ai.complete({
      job,
      system: "You are a connection test.",
      user: "Reply with the single word: ok",
      maxTokens: 20,
    });
    console.log(`ok      ${label}: ${model} (answered "${result.text.slice(0, 20)}", ${result.inputTokens}+${result.outputTokens} tokens)`);
  } catch (error) {
    failed = true;
    const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.log(`FAILED  ${label}: ${model}\n        ${reason.slice(0, 400)}`);
  }
}
process.exit(failed ? 1 : 0);
