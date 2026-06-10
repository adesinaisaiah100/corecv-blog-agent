import { ChatGoogle } from "@langchain/google";
import { z } from "zod";

interface ResilientLlmParams {
  model?: string;
  temperature?: number;
  structuredOutputSchema?: z.ZodTypeAny;
  tools?: any[];
}

export function createResilientLlm(params: ResilientLlmParams) {
  // 1st Priority: Primary Model (user setting or default)
  const primaryModel = params.model || "gemini-2.5-flash-lite";

  let primary: any = new ChatGoogle({ model: primaryModel, temperature: params.temperature });
  
  // 2nd Priority: Fallback to more capable/stable flash model
  let fallback1: any = new ChatGoogle({ model: "gemini-2.5-flash", temperature: params.temperature });
  
  // 3rd Priority: Absolute fallback safety net
  let fallback2: any = new ChatGoogle({ model: "gemini-flash-lite-latest", temperature: params.temperature });

  // Apply Structured Output to ALL models in the chain
  if (params.structuredOutputSchema) {
    primary = primary.withStructuredOutput(params.structuredOutputSchema);
    fallback1 = fallback1.withStructuredOutput(params.structuredOutputSchema);
    fallback2 = fallback2.withStructuredOutput(params.structuredOutputSchema);
  } 
  // OR apply tools to ALL models in the chain
  else if (params.tools) {
    primary = primary.bindTools(params.tools);
    fallback1 = fallback1.bindTools(params.tools);
    fallback2 = fallback2.bindTools(params.tools);
  }

  // Return the chained runnable
  return primary.withFallbacks({
    fallbacks: [fallback1, fallback2],
  });
}
