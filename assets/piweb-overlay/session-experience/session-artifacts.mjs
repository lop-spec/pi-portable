// This is a projection of a single session branch, not a directory scan.
// Link mentions remain distinguishable from file writes; filesystem checks are supplied by the route.
const textBlocks = message => (Array.isArray(message?.content) ? message.content : []).filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text);
export function referencedPaths(text) {
  const found = new Set();
  // A Markdown destination or inline-code span can contain spaces. Never treat a URL as a local file.
  for (const match of text.matchAll(/\]\(([^)\n]+)\)|`([^`\n]+)`/gu)) {
    let value = (match[1] ?? match[2]).trim().replace(/^<|>$/g, '');
    try { value = decodeURIComponent(value); } catch { /* leave malformed escapes intact */ }
    const absolute = /^(?:[a-z]:[\\/]|\/(?!\/)|file:)/iu.test(value);
    const relativeFile = !/^[a-z][a-z0-9+.-]*:/iu.test(value) && /\.[a-z0-9]{1,12}(?:[?#].*)?$/iu.test(value);
    if (absolute || relativeFile) found.add(value);
  }
  // Unquoted absolute Windows paths, common in short delivery replies.
  for (const match of text.matchAll(/\b[a-z]:[\\/][^\s`<>"|)\]）]+/giu)) {
    let value=match[0].replace(/[。，；：、]+$/u, '');
    try { value=decodeURIComponent(value); } catch { /* keep literal path */ }
    found.add(value);
  }
  return [...found];
}
export function collectSessionCandidates(entries, {writtenPaths,resolveReference = value => value}) {
  const results = new Map(), calls = [], mentions = [];
  for (const entry of entries) {
    const message = entry?.type === 'message' ? entry.message : null;
    if (message?.role === 'toolResult' && typeof message.toolCallId === 'string') results.set(message.toolCallId, message);
    if (message?.role !== 'assistant') continue;
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block?.type === 'toolCall') calls.push({ ...block, toolCallId: block.toolCallId ?? block.id, toolName: block.toolName ?? block.name, input: block.input ?? block.arguments });
    }
    if (message.stopReason === 'stop' || message.stopReason === 'end_turn') for (const text of textBlocks(message)) mentions.push(...referencedPaths(text));
  }
  const files = new Map();
  const add = (filePath, source) => {
    if (typeof filePath !== 'string' || !filePath) return;
    const key = /^[a-z]:/iu.test(filePath) ? filePath.replaceAll('\\','/').toLowerCase() : filePath;
    if (!files.has(key) || source === 'written') files.set(key, { filePath, source });
  };
  for (const item of writtenPaths(calls, results)) add(item.filePath, 'written');
  for (const call of calls) {
    if (!/(?:^|[._])codex_imagegen$/iu.test(call.toolName ?? '')) continue;
    const result=results.get(call.toolCallId);
    if (!result || result.isError) continue;
    if (typeof call.input?.output_path === 'string') add(resolveReference(call.input.output_path), 'written');
    for (const text of textBlocks(result)) {
      try {
        const payload=JSON.parse(text);
        for(const key of ['path','filePath','output_path','outputPath']) if(typeof payload?.[key] === 'string') add(resolveReference(payload[key]),'written');
      } catch { for(const value of referencedPaths(text)) add(resolveReference(value),'referenced'); }
    }
  }
  for (const value of mentions) add(resolveReference(value), 'referenced');
  return [...files.values()].reverse();
}
export function extensionOf(path) {
  const name = String(path).split(/[\\/]/u).at(-1) ?? '';
  const at = name.lastIndexOf('.');
  return at > 0 && at < name.length - 1 ? name.slice(at + 1).toLowerCase() : '';
}
