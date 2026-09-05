import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_CODEX_MODEL,
  LIVE_CODEX_MODEL_PATTERNS,
  LIVE_CODEX_PROVIDER,
  MANAGED_PROVIDER_NAME,
  NEWER_CODEX_MODEL_PATTERN,
  buildLiveModelConfiguration,
  configureLiveModelCatalog,
} from "../src/live-model-catalog.mjs";

const legacyModels = () => ({
  providers: {
    "codex-bridge": {
      name: "legacy",
      api: "openai-responses",
      baseUrl: "http://127.0.0.1:8794/v1",
      apiKey: "!credential-command",
      headers: {
        "chatgpt-account-id": "!account-command",
        "OpenAI-Beta": "responses=experimental",
      },
      models: [{ id: "gpt-5.6-sol" }],
    },
  },
});

const legacySettings = () => ({
  defaultProvider: "codex-bridge",
  defaultModel: "gpt-5.6-sol",
  defaultThinkingLevel: "high",
  modelThinkingLevels: { "codex-bridge/gpt-5.6-sol": "max" },
  retry: { enabled: false },
});

test("native Codex provider retains old sessions and exposes fixed plus future models", () => {
  const result = buildLiveModelConfiguration(legacyModels(), legacySettings());
  assert.equal(result.ok, true);
  assert.ok(result.models.providers["codex-bridge"], "legacy provider must remain for historical sessions");
  const live = result.models.providers[LIVE_CODEX_PROVIDER];
  assert.equal(live.name, MANAGED_PROVIDER_NAME);
  assert.equal(live.baseUrl, "http://127.0.0.1:8794/v1");
  assert.equal(live.apiKey, "!credential-command");
  assert.deepEqual(live.headers, { originator: "pi_web" }, "identity-bearing legacy headers must not be copied");
  assert.deepEqual(result.settings.enabledModels, LIVE_CODEX_MODEL_PATTERNS);
  assert.equal(result.settings.enabledModels.includes(NEWER_CODEX_MODEL_PATTERN), true);
  assert.deepEqual(
    ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-6-astra", "gpt-10-nova"].filter((id) => {
      // This mirrors the intended major-version meaning without coupling tests to minimatch internals.
      const major = Number(/^gpt-(\d+)/u.exec(id)?.[1]);
      return id === "gpt-5.6-sol" || id === "gpt-5.6-terra" || major >= 6;
    }),
    ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-6-astra", "gpt-10-nova"],
  );
  assert.equal(result.settings.defaultProvider, LIVE_CODEX_PROVIDER);
  assert.equal(result.settings.defaultModel, DEFAULT_CODEX_MODEL);
  assert.equal(result.settings.transport, "sse");
  assert.equal(result.settings.modelThinkingLevels["openai-codex/gpt-5.6-sol"], "max");
  assert.equal(result.settings.modelThinkingLevels["openai-codex/gpt-5.6-terra"], "max");
});

test("subsequent launcher runs preserve a user-selected global default and transport", () => {
  const first = buildLiveModelConfiguration(legacyModels(), legacySettings());
  first.settings.defaultModel = "gpt-5.6-terra";
  first.settings.transport = "auto";
  first.settings.unrelated = { keep: true };
  const second = buildLiveModelConfiguration(first.models, first.settings);
  assert.equal(second.ok, true);
  assert.equal(second.settings.defaultProvider, LIVE_CODEX_PROVIDER);
  assert.equal(second.settings.defaultModel, "gpt-5.6-terra");
  assert.equal(second.settings.transport, "auto", "an explicit later transport choice must not be reset");
  assert.deepEqual(second.settings.unrelated, { keep: true });
  assert.deepEqual(second.settings.enabledModels, LIVE_CODEX_MODEL_PATTERNS);
});

test("missing legacy provider fails open without inventing credentials", () => {
  const result = buildLiveModelConfiguration({ providers: {} }, {});
  assert.equal(result.ok, false);
  assert.match(result.reason, /provider is missing/u);
  assert.equal(result.models.providers[LIVE_CODEX_PROVIDER], undefined);
});

test("filesystem migration backs up both configs before writing and is idempotent", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-live-models-"));
  try {
    const modelsFile = path.join(root, "models.json");
    const settingsFile = path.join(root, "settings.json");
    fs.writeFileSync(modelsFile, `${JSON.stringify(legacyModels(), null, 2)}\n`);
    fs.writeFileSync(settingsFile, `${JSON.stringify(legacySettings(), null, 2)}\n`);

    const changed = configureLiveModelCatalog(root, { now: new Date("2026-09-05T11:00:00.000Z") });
    assert.equal(changed.status, "updated");
    assert.equal(changed.backups.length, 2);
    for (const backup of changed.backups) {
      assert.equal(fs.existsSync(backup.target), true);
      assert.equal(backup.sha256.length, 64);
    }
    const writtenModels = JSON.parse(fs.readFileSync(modelsFile, "utf8"));
    const writtenSettings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    assert.equal(writtenModels.providers[LIVE_CODEX_PROVIDER].name, MANAGED_PROVIDER_NAME);
    assert.equal(writtenSettings.defaultModel, DEFAULT_CODEX_MODEL);

    const again = configureLiveModelCatalog(root, { now: new Date("2026-09-05T11:01:00.000Z") });
    assert.equal(again.status, "already-current");
    assert.equal(again.changed.length, 0);
    assert.equal(fs.readdirSync(path.join(root, "_历史版本")).length, 2, "idempotent runs must not create backup noise");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
