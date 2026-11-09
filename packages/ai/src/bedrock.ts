import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";
import { AiError, type AiClient, type AiRequest, type AiResult } from "./client";

export interface BedrockConfig {
  /** e.g. eu-central-1 (Frankfurt). Comes from config, never hard-coded in jobs. */
  region: string;
  /** Bedrock model id, e.g. anthropic.claude-opus-5-5. Comes from config. */
  modelId: string;
}

/**
 * Claude through AWS Bedrock. AWS credentials are read from the standard
 * environment variables (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY) by the SDK.
 */
export function createBedrockClient(config: BedrockConfig): AiClient {
  const client = new AnthropicBedrockMantle({ awsRegion: config.region });
  return {
    async complete(request: AiRequest): Promise<AiResult> {
      const response = await client.messages.create({
        model: config.modelId,
        max_tokens: request.maxTokens,
        // Short, well-specified tasks: low effort keeps cost and latency down.
        output_config: { effort: "low" },
        system: request.system,
        messages: [{ role: "user", content: request.user }],
      });
      if (response.stop_reason === "refusal") {
        throw new AiError(`Model declined the ${request.job} request`);
      }
      if (response.stop_reason === "max_tokens") {
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
