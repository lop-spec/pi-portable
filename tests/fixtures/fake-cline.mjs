// Stand-in for the Cline CLI in tests/piweb-cline-agent.mjs: the same flags, endpoint
// discovery and request loop, with tools that only echo their arguments.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = name => args[args.indexOf(name) + 1];
// The real program needs about a second to load before it asks anything; tests set a delay to model that.
if (process.env.FAKE_CLINE_PIDFILE) fs.writeFileSync(process.env.FAKE_CLINE_PIDFILE, String(process.pid));
if (process.env.FAKE_CLINE_DELAY_MS) await new Promise(resolve => setTimeout(resolve, Number(process.env.FAKE_CLINE_DELAY_MS)));
const settings = JSON.parse(fs.readFileSync(path.join(flag('--data-dir'), 'settings', 'providers.json'), 'utf8'));
const { baseUrl, apiKey } = settings.providers['openai-compatible'].settings;
const messages = [{ role: 'system', content: 'You are Cline (fake).' }, { role: 'user', content: args.at(-1) }];
const tools = ['read_files', 'run_commands', 'ask_question', 'team_status'].map(name => ({
  type: 'function', function: { name, description: `${name} (fake)`, parameters: { type: 'object', properties: { value: { type: 'string' } } } },
}));

for (;;) {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: flag('-m'), messages, tools, stream: true }),
  });
  if (!res.ok) { console.error(`fake cline: HTTP ${res.status} ${await res.text()}`); process.exit(2); }
  let text = '', finish = null;
  const calls = [];
  for (const line of (await res.text()).split('\n')) {
    if (!line.startsWith('data: {')) continue;
    const choice = JSON.parse(line.slice(6)).choices[0];
    text += choice.delta.content ?? '';
    for (const call of choice.delta.tool_calls ?? []) calls.push(call);
    finish = choice.finish_reason ?? finish;
  }
  console.log(JSON.stringify({ type: 'fake', text, finish, calls: calls.map(call => call.function.name) }));
  if (finish !== 'tool_calls') process.exit(0);
  messages.push({ role: 'assistant', content: text, tool_calls: calls });
  for (const call of calls) messages.push({ role: 'tool', tool_call_id: call.id, content: `${call.function.name}:${call.function.arguments}` });
}
