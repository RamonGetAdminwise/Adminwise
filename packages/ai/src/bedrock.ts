import AnthropicBedrock from "@anthropic-ai/bedrock-sdk";
import { AiError, type AiClient, type AiRequest, type AiResult } from "./client";

export interface BedrockConfig {
  /** AWS region the requests are sent from, e.g. eu-central-1 (Frankfurt). */
  region: string;
  /**
   * Bedrock model id per task. The key is the job name a prompt uses
   * ("classify", "reply-draft", "voice-profile", later "quote"); any task
   * without its own entry uses `default`.
   */
  models: { default: string } & Record<string, string>;
}

/**
 * Claude through AWS Bedrock (InvokeModel). AWS credentials are read from the
 * standard environment variables (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY).
 *
 * The model ids are EU inference profiles ("eu." prefix): requests are sent to
 * `region` and Bedrock may serve them from any EU region in the profile, never
 * outside the EU. The "global." profiles are refused in config.ts.
 *
 * SDK note: @anthropic-ai/bedrock-sdk is pinned below 1.0 on purpose. Releases
 * from 1.0 send an API version that Bedrock rejects for Claude Sonnet 4.6 and
 * Haiku 4.5. Upgrade the SDK only after every task runs on Claude 4.7 or newer.
 */
export function createBedrockClient(config: BedrockConfig): AiClient {
  const client = new AnthropicBedrock({ awsRegion: config.region });
  return {
    async complete(request: AiRequest): Promise<AiResult> {
      const model = config.models[request.job] ?? config.models.default;
      const response = await client.messages.create({
        model,
        max_tokens: request.maxTokens,
        system: request.system,
        messages: [{ role: "user", content: request.user }],
      });
      const stopReason = response.stop_reason as string | null;
      if (stopReason === "refusal") {
        throw new AiError(`Model declined the ${request.job} request`);
      }
      if (stopReason === "max_tokens") {
        throw new AiError(`Model output for ${request.job} was cut off`);
      }
      const text = response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("")
        .trim();
      return {
        text,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      };
    },
  };
}
