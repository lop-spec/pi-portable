import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createFauxCore, fauxAssistantMessage } from '@earendil-works/pi-ai';
export default function provider(pi: ExtensionAPI) {
  const core = createFauxCore({ api: 'project-fixture-api', provider: 'project-fixture', models: [{ id: 'scripted' }] });
  core.setResponses([fauxAssistantMessage('完成。\n<归属 项目="Windows">修复音频设备切换</归属>')]);
  pi.registerProvider('project-fixture', { name: 'offline fixture', baseUrl: 'http://127.0.0.1:9', apiKey: 'fixture-not-a-secret', api: core.api as never,
    models: [{ id: 'scripted', name: 'scripted', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }], streamSimple: core.streamSimple as never });
}
