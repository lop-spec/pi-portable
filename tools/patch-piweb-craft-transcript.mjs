// Final presentation stage: Craft replaces Desktop, retaining Pi execution/data APIs.
export function integrateCraftTranscript({get,set,change,template}) {
  set('components/PortableProcessTimeline.tsx',template('craft-transcript/PortableProcessTimeline.tsx'));
  set('lib/craft-transcript-model.mjs',template('craft-transcript/model.mjs'));
  set('app/craft-transcript.css',template('craft-transcript/craft-transcript.css'));
  change('app/layout.tsx','import "./desktop-transcript.css";','import "./craft-transcript.css";');
  change('lib/message-display.ts','return block.type === "thinking" && !block.thinking.trim() && !_options.isStreaming;','return block.type === "thinking";');
  const pkg=JSON.parse(get('package.json'));
  pkg.piPortable.craftTranscript={source:'https://github.com/lop-spec/craft-agents-oss',commit:'a883d64e8cccb0612b18f06820755db5f5d17a34',license:'Apache-2.0',adapter:1};
  set('package.json',JSON.stringify(pkg,null,2)+'\n');
  set('public/licenses/craft-transcript/LICENSE',template('craft-transcript/LICENSE'));
  set('public/licenses/craft-transcript/NOTICE',template('craft-transcript/NOTICE'));
}
