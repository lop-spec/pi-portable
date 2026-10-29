// Final presentation stage: Craft replaces Desktop, retaining Pi execution/data APIs.
import crypto from 'node:crypto';
export function integrateCraftTranscript({get,set,change,template}) {
  set('components/PortableProcessTimeline.tsx',template('craft-transcript/PortableProcessTimeline.tsx'));
  set('lib/craft-transcript-model.mjs',template('craft-transcript/model.mjs'));
  set('app/craft-transcript.css',template('craft-transcript/craft-transcript.css'));
  change('app/layout.tsx','import "./desktop-transcript.css";','import "./craft-transcript.css";');
  change('lib/message-display.ts','return block.type === "thinking" && !block.thinking.trim() && !_options.isStreaming;','return block.type === "thinking";');
  change('lib/session-reader.ts','const CHAT_VIEW_TOOL_INPUT_KEYS = ["path", "file_path", "_intent", "_displayName"] as const;','const CHAT_VIEW_TOOL_INPUT_KEYS = ["path", "file_path", "_intent", "_displayName", "command", "pattern", "url", "query", "action"] as const;');
  change('lib/session-reader.ts','if (typeof call.input?.[key] === "string") input[key] = call.input[key];','if (typeof call.input?.[key] === "string") input[key] = ["command", "pattern", "url", "query"].includes(key) ? call.input[key].slice(0, 200) : call.input[key];');
  change('components/ChatWindow.tsx','            entries={entries}\n            toolResults={toolResultsMap}','            entries={entries}\n            toolResultEntryIds={new Map(messages.flatMap((m, i) => m.role === "toolResult" && entryIds[i] ? [[m.toolCallId, entryIds[i]] as [string, string]] : []))}\n            toolResults={toolResultsMap}');
  const pkg=JSON.parse(get('package.json'));
  pkg.piPortable.craftTranscript={source:'https://github.com/lop-spec/craft-agents-oss',commit:'a883d64e8cccb0612b18f06820755db5f5d17a34',license:'Apache-2.0',adapter:1};
  set('package.json',JSON.stringify(pkg,null,2)+'\n');
  set('public/licenses/craft-transcript/LICENSE',template('craft-transcript/LICENSE'));
  set('public/licenses/craft-transcript/NOTICE',template('craft-transcript/NOTICE'));
  const manifest=JSON.parse(template('craft-transcript/manifest.json'));
  for(const [name,sha] of Object.entries(manifest.files))if(crypto.createHash('sha256').update(get(name)).digest('hex')!==sha)throw new Error(name+': Craft final-stage hash mismatch; zero writes');
}
