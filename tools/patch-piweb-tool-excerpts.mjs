// Final presentation stage, after pinned history/stop stages. No model/session writes.
import { createHash } from 'node:crypto';
export const TOOL_EXCERPT_CHANGED_FILES = ['components/PortableProcessTimeline.tsx', 'lib/session-reader.ts'];
export function integrateToolExcerpts({ get, set, change, prepend, template }) {
  set('lib/tool-chinese-excerpts.mjs', template('tool-excerpts/tool-chinese-excerpts.mjs'));
  set('components/ToolChineseExcerpt.tsx', template('tool-excerpts/ToolChineseExcerpt.tsx'));
  const view = 'components/PortableProcessTimeline.tsx';
  prepend(view, 'import { ToolChineseExcerpt } from "./ToolChineseExcerpt";\nimport { newToolChineseExcerpts } from "@/lib/tool-chinese-excerpts.mjs";\n');
  change(view, '  | { type: "tools"; key: string; calls: ToolItem[] }', '  | { type: "tool-excerpt"; key: string; phrases: string[]; toolName: string; entryId?: string }\n  | { type: "tools"; key: string; calls: ToolItem[] }');
  change(view, '  modelNames?: Record<string, string>,\n): Item[] {', '  modelNames?: Record<string, string>,\n  toolResults: Map<string, ToolResultMessage> = new Map(),\n): Item[] {');
  change(view, '  const items: Item[] = [];', '  const items: Item[] = [];\n  const seenExcerpts = new Set<string>();');
  change(view, '      if (block.type === "toolCall") {\n        if (!showTool(block)) return;', `      if (block.type === "toolCall") {
        const phrases = newToolChineseExcerpts(toolResults.get(block.toolCallId), seenExcerpts);
        if (phrases.length) pushContent({ type: "tool-excerpt", key: \`excerpt-\${block.toolCallId}\`, phrases, toolName: block.toolName, entryId: entry.entryId });
        if (!showTool(block)) return;`);
  change(view, 'buildTimelineItems(entries, block => block === searchBlock, modelNames), [entries, searchBlock, modelNames]', 'buildTimelineItems(entries, block => block === searchBlock, modelNames, toolResults), [entries, searchBlock, modelNames, toolResults]');
  change(view, '            if (item.type === "tools") {', `            if (item.type === "tool-excerpt") {
              return <li key={item.key} className="pw-proc-item pw-proc-narr"><ToolChineseExcerpt phrases={item.phrases} toolName={item.toolName} entryId={item.entryId} /></li>;
            }
            if (item.type === "tools") {`);
  // Extract from the full result BEFORE history previews are shortened, without shipping the raw output.
  const reader = 'lib/session-reader.ts';
  prepend(reader, 'import { toolChineseExcerpts } from "./tool-chinese-excerpts.mjs";\n');
  change(reader, 'chatView: { bytes: number; images: number; truncated: boolean }', 'chatView: { bytes: number; images: number; truncated: boolean; chineseExcerpts: string[] }');
  change(reader, 'chatView: { bytes, images, truncated: text.length > CHAT_VIEW_PREVIEW_CHARS || images > 0 },', 'chatView: { bytes, images, truncated: text.length > CHAT_VIEW_PREVIEW_CHARS || images > 0, chineseExcerpts: toolChineseExcerpts(result) },');
  const manifest = JSON.parse(template('tool-excerpts/manifest.json'));
  for (const [name, expected] of Object.entries(manifest.files)) {
    if (createHash('sha256').update(get(name)).digest('hex') !== expected) throw new Error(`${name}: tool excerpts stage hash mismatch; zero writes`);
  }
}
