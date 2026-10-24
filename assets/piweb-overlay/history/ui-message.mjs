// Display DTO only. Never mutate persisted entries or provider/model messages.
const share = (before, after) => before && Object.keys(before).length === Object.keys(after).length && Object.keys(after).every(k => before[k] === after[k]) ? before : after;
export function uiMessage(message) {
  if (message?.role !== 'assistant') return message;
  let content = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : (Array.isArray(message.content) ? message.content : []).map(block => share(block, (() => {
    if (!block || typeof block !== 'object') return { type: 'unknown' };
    if (block.type === 'text') return { type: 'text', text: block.text };
    if (block.type === 'thinking') return { type: 'thinking', thinking: block.thinking, ...(block.deferred ? { deferred: true } : {}) };
    if (block.type === 'toolCall') return { type: 'toolCall', toolCallId: block.toolCallId ?? block.id, toolName: block.toolName ?? block.name, input: block.input ?? block.arguments, ...(block.rawInput !== undefined ? { rawInput: block.rawInput } : {}) };
    if (block.type === 'image') return { type: 'image', source: block.source, ...(block.data ? { data: block.data, mimeType: block.mimeType } : {}) };
    return { type: block.type }; // preserve block indexes, not opaque provider-only data
  })()));
  if (Array.isArray(message.content) && content.length === message.content.length && content.every((b, i) => b === message.content[i])) content = message.content;
  const out = { role: 'assistant', content, model: message.model, provider: message.provider };
  for (const key of ['api', 'stopReason', 'rawStopReason', 'errorMessage', 'timestamp', 'usage']) if (message[key] !== undefined) out[key] = message[key];
  return share(message, out);
}
