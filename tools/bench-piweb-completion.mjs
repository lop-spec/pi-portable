// Compare projectCraftTurn on the same immutable completed calls while a final
// answer is streamed, with one additional live->settled transition per sample.
// Usage: node tools/bench-piweb-completion.mjs <baseline model.mjs> <candidate model.mjs>
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const paths = process.argv.slice(2);
if (paths.length !== 2) throw Error('Expected baseline and candidate paths');
const [base, next] = await Promise.all(paths.map(async path => (await import(pathToFileURL(resolve(path)).href)).projectCraftTurn));
const content = Array.from({ length: 24 }, (_, i) => ({ type: 'toolCall', toolCallId: `call-${i}`, toolName: 'run_commands', input: { command: 'echo "校验记录与目录"', _phase: `阶段 ${Math.floor(i / 6)}` } }));
const results = new Map(content.map((block, i) => [block.toolCallId, { role: 'toolResult', content: [{ type: 'text', text: '核对历史工具输出'.repeat(i < 6 ? 1800 : 40) }] }]));
const prefix = [{ kind: 'assistant', key: 'tools', message: { content } }];
const end = { status: 'done' };
const fixture = Array.from({ length: 24 }, (_, i) => [...prefix, { kind: 'assistant', key: 'streaming', streaming: true, message: { content: [{ type: 'text', text: '结论段落。'.repeat(i+1) }] } }]);
for (const [entries, live] of [[fixture.at(-1), true], [prefix, false]]) {
  const normalized = project => JSON.stringify(project(entries, results, live, end));
  const stripMarker = value => value.replaceAll(',"streaming":true', '');
  assert.equal(stripMarker(normalized(base)), stripMarker(normalized(next)));
}
for (const project of [base, next]) for (let i=0; i<40; i++) project(fixture.at(-1), results, true);
const samples = [[], []];
const finalSamples = [[], []];
const variants = [base, next];
for (let i=0; i<16; i++) {
  for (const index of [i%2, 1-i%2]) {
    const project = variants[index];
    for (const entries of fixture) {
      const t = performance.now();
      project(entries, results, true);
      samples[index].push((performance.now()-t)*1000);
    }
    const t = performance.now();
    project(prefix, results, false, end);
    finalSamples[index].push((performance.now()-t)*1000);
  }
}
const stats = values => {
  const sorted = values.sort((a,b)=>a-b);
  return { n: values.length, p50: Math.round(sorted[Math.ceil(values.length*.5)-1]), p95: Math.round(sorted[Math.ceil(values.length*.95)-1]) };
};
console.log(JSON.stringify({ unit: 'µs', calls: content.length, outputChars: [...results.values()].reduce((n,r)=>n+r.content[0].text.length,0), stream: samples.map(stats), settle: finalSamples.map(stats) },null,2));
