/**
 * The one door to the model. Jobs never talk to Bedrock directly; they call
 * the functions in jobs.ts, which build a prompt from ai/prompts and send it
 * through an AiClient. Tests plug in a scripted client instead of Bedrock.
 */
export interface AiRequest {
  /** Name of the prompt/job, for the job log. Never contains email content. */
  job: string;
  system: string;
  user: string;
  maxTokens: number;
}

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface AiResult extends AiUsage {
  text: string;
}

export interface AiClient {
  complete(request: AiRequest): Promise<AiResult>;
}

export class AiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiError";
  }
}
