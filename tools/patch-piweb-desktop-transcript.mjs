// Final, source-only stage. Desktop presentation replaces the retired custom timeline.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../assets/piweb-overlay/desktop-transcript/',import.meta.url));
export function integrateDesktopTranscript({get,set,change,template}){
  const vendor=path.join(root,'vendor');
  const manifest=JSON.parse(fs.readFileSync(path.join(vendor,'provenance.json'),'utf8'));
  for(const entry of manifest.files){
    const content=fs.readFileSync(path.join(vendor,entry.name),'utf8');
    if(crypto.createHash('sha256').update(content).digest('hex')!==entry.sha256)throw new Error(entry.name+': Desktop vendor hash mismatch; zero writes');
  }
  for(const name of fs.readdirSync(vendor).filter(n=>/\.(ts|tsx)$/.test(n)))set('components/desktop-transcript/'+name,fs.readFileSync(path.join(vendor,name),'utf8'));
  set('components/PortableProcessTimeline.tsx',template('desktop-transcript/PortableProcessTimeline.tsx'));
  set('app/desktop-transcript.css',template('desktop-transcript/desktop-transcript.css'));
  // Imported last so Pi Web's existing typography cannot change the original process metrics.
  change('app/layout.tsx','import "./redesign-chrome.css";','import "./redesign-chrome.css";\nimport "./desktop-transcript.css";');
  // Original Desktop shows every available reasoning language, never translates/extracts it.
  change('lib/message-display.ts','return block.type === "thinking" && chineseShare(block.thinking) < CHINESE_REASONING_MIN_SHARE;','return block.type === "thinking" && !block.thinking.trim() && !_options.isStreaming;');
  // Stop computing independent excerpts even for the shortened historical payloads.
  change('lib/session-reader.ts','import { toolChineseExcerpts } from "./tool-chinese-excerpts.mjs";\n','');
  change('lib/session-reader.ts','truncated: boolean; chineseExcerpts: string[]','truncated: boolean');
  change('lib/session-reader.ts',', chineseExcerpts: toolChineseExcerpts(result)','');
  const pkg=JSON.parse(get('package.json'));pkg.dependencies['lucide-react']='1.31.0';pkg.dependencies.shiki='4.4.3';
  pkg.piPortable.desktopTranscript={version:manifest.version,commit:manifest.commit,license:manifest.license};
  set('package.json',JSON.stringify(pkg,null,2)+'\n');
  for(const name of ['COPYING.LESSER','COPYING','provenance.json','NOTICE'])set('public/licenses/pi-desktop/'+name,fs.readFileSync(path.join(vendor,name),'utf8'));
  for(const name of fs.readdirSync(vendor).filter(n=>/\.(ts|tsx|css)$/.test(n)))set('public/licenses/pi-desktop/source/'+name+'.txt',fs.readFileSync(path.join(vendor,name),'utf8'));
  set('public/licenses/pi-desktop/source/PortableProcessTimeline.tsx.txt',template('desktop-transcript/PortableProcessTimeline.tsx'));
  const pinned=JSON.parse(template('desktop-transcript/manifest.json'));
  for(const [name,expected] of Object.entries(pinned.files))if(crypto.createHash('sha256').update(get(name)).digest('hex')!==expected)throw new Error(name+': Desktop final-stage hash mismatch; zero writes');
}
