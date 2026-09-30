import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLiveModelConfiguration, GPT6_CODEX_IDS, GPT6_THINKING_MAP } from '../src/live-model-catalog.mjs';

const models = () => ({ providers: {
  'codex-bridge': { apiKey: '!unchanged', baseUrl: 'http://127.0.0.1:8794/v1' },
  'openai-codex': { modelOverrides: { 'gpt-6-astra': { contextWindow: 1050000 } } },
} });

test('GPT-6 efforts preserve user settings, register missing models, and remain idempotent', () => {
  const settings = { defaultProvider: 'openai-codex', defaultModel: 'gpt-6-astra', defaultThinkingLevel: 'minimal',
    modelThinkingLevels: { 'openai-codex/gpt-6-sol': 'high' }, unrelated: true };
  const result = buildLiveModelConfiguration(models(), settings, { fileAuth: true });
  assert.equal(result.ok, true);
  assert.equal(result.settings.defaultThinkingLevel, 'low');
  assert.equal(result.settings.modelThinkingLevels['openai-codex/gpt-6-sol'], 'high');
  assert.equal(result.settings.unrelated, true);
  const provider = result.models.providers['openai-codex'];
  assert.equal(provider.modelOverrides['gpt-6-astra'].contextWindow, 1050000);
  for (const id of GPT6_CODEX_IDS) assert.deepEqual(provider.modelOverrides[id].thinkingLevelMap, GPT6_THINKING_MAP);
  assert.deepEqual(Object.values(GPT6_THINKING_MAP).filter(Boolean), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(provider.models.map(model => model.id), ['gpt-6-sol', 'gpt-6-luna', 'gpt-6.1-sol']);
  assert.deepEqual(buildLiveModelConfiguration(result.models, result.settings, { fileAuth: true }), result);
  const custom = models();
  custom.providers['openai-codex'].models = [{ id: 'gpt-6-sol', name: 'Keep name', contextWindow: 500000 }];
  const customized = buildLiveModelConfiguration(custom, settings, { fileAuth: true });
  assert.equal(customized.models.providers['openai-codex'].models[0].contextWindow, 500000);
  assert.equal(customized.models.providers['openai-codex'].models[0].name, 'Keep name');
});
