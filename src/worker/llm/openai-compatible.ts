export {
  OpenAiCompatibleModelClient,
  normalizeChatCompletionsUrl,
  normalizeOpenAICompatibleBaseUrl,
  streamChatCompletion,
} from "../model/openai-compatible";
export type {
  ModelClient,
  ModelStreamOptions as StreamChatOptions,
  ModelStreamResult as StreamChatResult,
} from "../model/types";
