// Session snapshots never depend on mutable defaults for future conversations.
/**
 * @param {Array<{type: string, provider?: string, modelId?: string, thinkingLevel?: string,
 * message?: {role?: string, provider?: string, model?: string}}>} branch
 */
export function savedSessionSettings(branch) {
  /** @type {{provider: string, modelId: string} | null} */
  let model = null;
  /** @type {{provider: string, modelId: string} | null} */
  let responseModel = null;
  /** @type {string | undefined} */
  let thinkingLevel;
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (!model && entry.type === 'model_change' && entry.provider && entry.modelId) {
      model = {provider: entry.provider, modelId: entry.modelId};
    }
    if (!responseModel && entry.type === 'message' && entry.message?.role === 'assistant'
        && entry.message.provider && entry.message.model) {
      responseModel = {provider: entry.message.provider, modelId: entry.message.model};
    }
    if (thinkingLevel === undefined && entry.type === 'thinking_level_change'
        && ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(entry.thinkingLevel ?? '')) {
      thinkingLevel = entry.thinkingLevel;
    }
    if (model && thinkingLevel !== undefined) break;
  }
  return {model: model ?? responseModel, thinkingLevel};
}
