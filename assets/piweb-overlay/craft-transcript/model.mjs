// Pi adapter for Craft's WorkLog/ActivityRow contract. Never mutates persisted messages.
export function toolState(result, live, end) {
  if (!result) return live ? 'running' : end?.status === 'stopped' ? 'stopped' : 'unknown';
  const d = result.details;
  if (result.isError || (typeof d?.exitCode === 'number' && d.exitCode !== 0) || d?.status === 'error' || d?.status === 'failed') return 'error';
  return 'completed';
}
export function toolSummary(block) {
  const args = block.input ?? {};
  const name = typeof args._displayName === 'string' && args._displayName.trim() ? args._displayName : block.toolName;
  const intent = typeof args._intent === 'string' ? args._intent : typeof args.description === 'string' ? args.description : '';
  const input = ['command', 'path', 'file_path', 'pattern', 'url', 'query', 'action'].map(key => typeof args[key] === 'string' ? args[key] : '').filter(Boolean).join(' ');
  return { name, intent, input };
}
export function projectCraftTurn(entries, toolResults, live = false, end) {
  const activities = [], responses = [], nodes = [];
  for (const entry of entries) {
    if (entry.kind !== 'assistant') { nodes.push(entry); continue; }
    entry.message.content.forEach((block, index) => {
      if (block.type === 'thinking') return;
      const base = { id: `${entry.entryId ?? entry.key}:${index}`, entryId: entry.entryId, block, timestamp: entry.message.timestamp };
      if (block.type === 'toolCall') {
        const result = toolResults.get(block.toolCallId);
        activities.push({ ...base, id: block.toolCallId, type: 'tool', result, status: toolState(result, live, end), ...toolSummary(block) });
      } else if (block.type === 'text' && block.text.trim()) activities.push({ ...base, type: 'intermediate', status: 'completed', name: block.text.replace(/\s+/g, ' '), intent: '', input: '' });
    });
  }
  // Like Craft, the trailing streamed answer is outside the work log. Earlier
  // commentary remains a compact activity once subsequent tool activity arrives.
  if (live) while (activities.at(-1)?.type === 'intermediate') responses.unshift(activities.pop());
  return { activities, responses, nodes, failedCount: activities.filter(a => a.status === 'error').length };
}
