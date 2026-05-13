import Anthropic from "@anthropic-ai/sdk";

export const claudeClient = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
});
