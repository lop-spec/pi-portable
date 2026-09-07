#!/usr/bin/env node
// Source-level downstream integration. Official fixes stay intact; no minified
// symbol/hash anchors, no local release build, and no writes before validation.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getClipboardPastePlan, normalizeClipboardImages, formatAtMentions, uploadClipboardFiles } from './patch-piweb-interactions.mjs';
import { filterSessionsForWorktree } from './patch-piweb-worktree-sessions.mjs';
import { conversationMessageText, toConversationNodeLine, conversationUserQuestion, collectConversationNodeRecords } from './patch-piweb-conversation-nodes.mjs';
import { applyServiceTierRpc } from './patch-piweb-service-tier.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const templates = path.join(repo, 'assets/piweb-overlay');
export const upstream = JSON.parse(fs.readFileSync(path.join(repo, 'assets/piweb-upstream.json'), 'utf8'));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const normalize = value => value.replaceAll('\r\n', '\n');
const template = name => normalize(fs.readFileSync(path.join(templates, name), 'utf8'));

export function integrate(getFile) {
  const files = new Map();
  const get = name => files.has(name) ? files.get(name) : normalize(getFile(name));
  const set = (name, value) => files.set(name, value);
  const change = (name, old, next, count = 1) => {
    const source = get(name), actual = source.split(old).length - 1;
    if (actual !== count) throw new Error(`${name}: anchor ${JSON.stringify(old.slice(0, 75))} matched ${actual}, expected ${count}; zero writes`);
    set(name, source.replaceAll(old, next));
  };
  const prepend = (name, text) => {
    const source = get(name), directive = '"use client";\n';
    set(name, source.startsWith(directive) ? directive + text + source.slice(directive.length) : text + source);
  };
  const input = 'components/ChatInput.tsx', hook = 'hooks/useAgentSession.ts', chat = 'components/ChatWindow.tsx', sidebar = 'components/SessionSidebar.tsx';
  const runtime = [getClipboardPastePlan, normalizeClipboardImages, formatAtMentions, uploadClipboardFiles, filterSessionsForWorktree, conversationMessageText, toConversationNodeLine, conversationUserQuestion, collectConversationNodeRecords].map(fn => `export ${fn.toString()}`).join('\n\n');
  set('lib/pi-portable-runtime.js', `${runtime}\n\nexport function readPreference(key, fallback = null) {\n  if (typeof window === 'undefined') return fallback;\n  try { const value = localStorage.getItem(key); return value === null ? fallback : JSON.parse(value); }\n  catch (error) { console.error('[pi-web] preference read failed:', key, error); return fallback; }\n}\nexport function rememberPreference(key, value) {\n  try { localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value)); } catch (error) { console.error('[pi-web] preference write failed:', key, error); }\n}\n`);
  set('components/PortableControls.tsx', template('PortableControls.tsx'));
  set('components/PortableNodes.tsx', template('PortableNodes.tsx'));
  set('app/portable.css', template('portable.css'));
  set('app/globals.css', get('app/globals.css') + '\n' + template('portable.css'));

  // Official draft-store, process grouping, scroll restoration, sidebar
  // virtualization and highlight cache replace the retired 0.8.11 patches.
  prepend(sidebar, 'import { filterSessionsForWorktree } from "@/lib/pi-portable-runtime.js";\n');
  change(sidebar, '  const sessionFamilies = listSessionFamilies(filteredSessions);', '  const categorySessions = showWorktreeSwitcher ? filterSessionsForWorktree(filteredSessions, worktreeState, selectedCwd) : filteredSessions;\n  const sessionFamilies = listSessionFamilies(categorySessions);');
  change(sidebar, '{worktreeState.worktrees.length > 1 && (', '{(');
  change(sidebar, '{worktreeState.worktrees.length}', '{sessionFamilies.length}');
  change(sidebar, '  const initialLoadDone = useRef(false);', `  useEffect(() => {
    const refresh = () => { void loadSessions(false, true); };
    document.addEventListener('pi-web:refresh-sessions', refresh);
    return () => document.removeEventListener('pi-web:refresh-sessions', refresh);
  }, [loadSessions]);
  const initialLoadDone = useRef(false);`);
  change(sidebar, '<PiWebTitle />', '<PiWebTitle />\n          <span data-pi-archive-slot="true" style={{ width: 48, height: 32, flexShrink: 0 }} />');
  // The portal uses a reserved native slot, not a guessed gap or React siblings.
  change(sidebar, '      onClick={confirmDelete || renaming ? undefined : onClick}', '      data-pi-session-id={session.id}\n      onClick={confirmDelete || renaming ? undefined : onClick}');

  const shell = 'components/AppShell.tsx';
  change(shell, `    if (
      currentProject === newProject
      && (selectedSession !== null || currentFreshCwd === cwd)
    ) {
      return;
    }`, `    if (currentFreshCwd === cwd || selectedSession?.cwd === cwd) return;`);
  change(shell, `    if (currentProject !== newProject) {
      // File tabs are keyed by absolute path, so tabs opened in the previous
      // project must not linger. Same-project worktree switches keep them.
      setFileTabs([]);`, `    {
      // A worktree is a portable session category. Clear files but leave
      // independently-owned terminal tabs and their processes untouched.
      setFileTabs([]);`);
  change(shell, '      restoreWorkspaceContext(newProject, cwd);', '      if (currentProject !== newProject) restoreWorkspaceContext(newProject, cwd);');

  const models = 'app/api/models/route.ts';
  change(models, 'import { getSupportedThinkingLevels }', 'import { getSupportedThinkingLevels, clampThinkingLevel }');
  change(models, 'async function loadModels(cwd: string): Promise<ModelsData>', 'async function loadModels(cwd: string, force = false): Promise<ModelsData>');
  change(models, '  const modelError = services.modelRuntime.getError();', `  const refreshed = await services.modelRuntime.refresh({ allowNetwork: true, force, providers: ['openai-codex'] });
  if (refreshed.errors.size) console.error('[pi-web] model catalog refresh failed:', [...refreshed.errors.keys()].join(','));
  const modelError = services.modelRuntime.getError();`);
  change(models, '    thinkingLevels[key] = getSupportedThinkingLevels(m);', `    thinkingLevels[key] = getSupportedThinkingLevels(m);
    thinkingLevelPins[\`\${m.provider}/\${m.id}\`] = clampThinkingLevel(m,
      (thinkingLevelPins[\`\${m.provider}/\${m.id}\`] ?? settings.getModelThinkingLevel(m.provider, m.id) ?? settings.getDefaultThinkingLevel() ?? 'medium') as Parameters<typeof clampThinkingLevel>[1]);`);
  change(models, 'return Response.json(await loadModelsWithCache(cwd, () => loadModels(cwd)));', 'return Response.json(await (new URL(req.url).searchParams.get("refresh") === "1" ? loadModels(cwd, true) : loadModelsWithCache(cwd, () => loadModels(cwd))));');
  change(models, '  } catch {\n    return Response.json(withSafeModelLoadFailure(EMPTY_MODELS));', '  } catch (error) {\n    console.error("[pi-web] model listing failed:", error);\n    return Response.json(withSafeModelLoadFailure(EMPTY_MODELS));');

  prepend(hook, 'import { readPreference, rememberPreference } from "@/lib/pi-portable-runtime.js";\n');
  change(hook, 'useState<SelectedModel | null>(null);\n  const [toolPreset', 'useState<SelectedModel | null>(() => readPreference("pi-last-model"));\n  const [toolPreset');
  change(hook, 'useState<ToolPreset>("default")', 'useState<ToolPreset>("full")');
  change(hook, 'useState<ThinkingLevelOption>("auto")', `useState<ThinkingLevelOption>(() => {
    if (typeof window === 'undefined') return 'medium';
    try { const value = localStorage.getItem('pi-last-thinking-level'); return ['off','minimal','low','medium','high','xhigh','max'].includes(value ?? '') ? value as ThinkingLevelOption : 'medium'; }
    catch (error) { console.error('[pi-web] last thinking preference read failed:', error); return 'medium'; }
  })`);
  change(hook, 'const loadModels = useCallback(async (signal?: AbortSignal) => {', 'const loadModels = useCallback(async (signal?: AbortSignal, force = false) => {');
  change(hook, 'const modelsUrl = modelCwd ? `/api/models?cwd=${encodeURIComponent(modelCwd)}` : "/api/models";', 'const modelsUrl = (modelCwd ? `/api/models?cwd=${encodeURIComponent(modelCwd)}` : "/api/models") + (force ? (modelCwd ? "&" : "?") + "refresh=1" : "");');
  change(hook, 'setThinkingLevel((pinned as ThinkingLevelOption | undefined) ?? "auto");', 'setThinkingLevel((pinned as ThinkingLevelOption | undefined) ?? "medium");');
  change(hook, '  const handleBuiltinSlashCommand = useCallback', `  useEffect(() => {
    let controller: AbortController | null = null;
    const refresh = (event: MouseEvent) => {
      const button = event.target instanceof Element ? event.target.closest('.model-selector>button[aria-haspopup="listbox"]') : null;
      if (!button || button.getAttribute('aria-expanded') === 'true') return;
      controller?.abort(); controller = new AbortController();
      void loadModels(controller.signal, true).catch(error => {
        if (error?.name !== 'AbortError') console.error('[pi-web] live model refresh failed:', error);
      });
    };
    document.addEventListener('click', refresh, true);
    return () => { controller?.abort(); document.removeEventListener('click', refresh, true); };
  }, [loadModels]);

  const handleBuiltinSlashCommand = useCallback`);
  change(hook, 'const handleModelChange = useCallback(async (provider: string, modelId: string) => {', 'const handleModelChange = useCallback(async (provider: string, modelId: string) => {\n    if (modelSwitchPendingRef.current) return;');
  change(hook, `      const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
      if (!sid) return;
      try {
        await sendAgentCommand(sid, { type: "set_model", provider, modelId });
      } catch (e) {
        console.error("Failed to set model:", e);
      }`, `      modelSwitchPendingRef.current = true;
      setModelSwitching(true);
      try {
        const sid = sessionIdRef.current ?? await ensureNewSession();
        if (!sid) throw new Error("会话初始化失败");
        await sendAgentCommand(sid, { type: "set_model", provider, modelId });
      } catch (e) {
        console.error("Failed to set model:", e);
        addNotice({ type: "error", message: "默认模型保存失败：" + (e instanceof Error ? e.message : String(e)) });
      } finally {
        modelSwitchPendingRef.current = false;
        setModelSwitching(false);
      }`);
  change(hook, 'await sendAgentCommand(sid, { type: "set_model", provider, modelId });', 'await sendAgentCommand(sid, { type: "set_model", provider, modelId });\n        rememberPreference("pi-last-model", { provider, modelId });', 2);
  change(hook, '[addNotice, currentModelOverride, isNew, loadSession, setNewSessionModel]', '[addNotice, currentModelOverride, ensureNewSession, isNew, loadSession, setNewSessionModel]');
  change(hook, 'const handleThinkingLevelChange = useCallback(async (level: ThinkingLevelOption) => {', 'const handleThinkingLevelChange = useCallback(async (level: ThinkingLevelOption) => {\n    if (level !== "auto") rememberPreference("pi-last-thinking-level", level);');
  change(hook, '        default:\n          return { handled: false };', `        case "lop-followup-ui": {
          if (!sid || !['thorough','target','root-cause','root-fix','plan','off'].includes(args)) return complete({ handled: true, error: '自动追问模式或会话无效' });
          await sendAgentCommand(sid, { type: 'prompt', message: \`/lop-followup \${args}\` });
          const state = await sendAgentCommand<{ extensionStatuses?: ExtensionStatusItem[] }>(sid, { type: 'get_state' });
          if (state?.extensionStatuses) setExtensionStatuses(state.extensionStatuses);
          return complete({ handled: true, message: args === 'off' ? '自动追问已停止' : '自动追问模式已选择' });
        }
        default:
          return { handled: false };`);

  change('lib/pi-types.ts', 'setModel(model: ModelLike): Promise<void>;', 'setModel(model: ModelLike, options?: { persist?: boolean }): Promise<void>;');
  const rpc = 'lib/rpc-manager.ts';
  change(rpc, '        await this.inner.setModel(model);', `        await this.inner.setModel(model, { persist: true });
        await this.inner.settingsManager.flush();
        const errors = this.inner.settingsManager.drainErrors();
        if (errors.length) { console.error('[pi-web] global model default persist failed:', errors); throw new Error('Failed to persist global model default'); }`);
  // Reuse the already-tested provider hook without changing model dispatch.
  const tier = applyServiceTierRpc('case"set_thinking_level":{let level=command.level;').out.split('case"set_thinking_level":')[0];
  set('lib/pi-portable-tier.js', `export function setPortableServiceTier(inner, serviceTier) {\n  const command = { serviceTier };\n  return function() { switch('set_service_tier') { ${tier} } }.call({ inner });\n}\n`);
  prepend(rpc, 'import { setPortableServiceTier } from "@/lib/pi-portable-tier.js";\n');
  change(rpc, '      case "set_thinking_level": {', '      case "set_service_tier": return setPortableServiceTier(this.inner, command.serviceTier);\n      case "set_thinking_level": {');

  prepend(input, 'import { PortableFollowup } from "./PortableControls";\nimport { getClipboardPastePlan, normalizeClipboardImages, formatAtMentions, uploadClipboardFiles } from "@/lib/pi-portable-runtime.js";\n');
  change(input, '  const [toolDropdownOpen, setToolDropdownOpen]', `  const [pasteStatus, setPasteStatus] = useState({ busy: false, error: "" });
  const pasteTarget = JSON.stringify([cwd, draftKey]);
  const pasteTargetRef = useRef(pasteTarget);
  pasteTargetRef.current = pasteTarget;
  const pendingPastes = useRef(new Map<string, number>());
  const pasteMountedRef = useRef(true);
  useEffect(() => { pasteMountedRef.current = true; return () => { pasteMountedRef.current = false; }; }, []);
  useEffect(() => { setPasteStatus({ busy: (pendingPastes.current.get(pasteTarget) ?? 0) > 0, error: "" }); }, [pasteTarget]);
  const [toolDropdownOpen, setToolDropdownOpen]`);
  change(input, '    const msg = value.trim();', '    if ((pendingPastes.current.get(pasteTargetRef.current) ?? 0) > 0) return;\n    const msg = value.trim();', 2);
  change(input, 'disabled={!value.trim() && !attachedImages.length}', 'disabled={pasteStatus.busy || (!value.trim() && !attachedImages.length)}');
  change(input, 'const canQueueStreamingMessage = hasInputText || attachedImages.length > 0;', 'const canQueueStreamingMessage = !pasteStatus.busy && (hasInputText || attachedImages.length > 0);');
  change(input, 'const THINKING_LEVELS = ["auto",', 'const THINKING_LEVELS = [');
  change(input, '  auto: "chat.thinkingUseDefault", off:', '  off:');
  change(input, 'const lvl = thinkingLevel ?? "auto";', 'const lvl = thinkingLevel === "auto" ? "medium" : thinkingLevel ?? "medium";');
  change(input, 'if (lvl === "auto" || !thinkingLevelMap)', 'if (!thinkingLevelMap)');
  change(input, '                      if (lvl === "auto") return true;\n', '');
  change(input, '(lvl !== "auto" && thinkingLevelMap)', 'thinkingLevelMap');
  change(input, 'onToolPresetChange(preset);', 'onToolPresetChange?.(preset);');
  const pasteStart = get(input).indexOf('  const handlePaste = useCallback(');
  const pasteEnd = get(input).indexOf('\n\n  useEffect', pasteStart);
  if (pasteStart < 0 || pasteEnd < 0) throw new Error('native paste handler missing');
  change(input, get(input).slice(pasteStart, pasteEnd), `  const insertPastedText = useCallback((text: string, separate = false) => {
    if (!text) return;
    const ta = textareaRef.current;
    const current = ta?.value ?? valueRef.current;
    const start = ta?.selectionStart ?? current.length, end = ta?.selectionEnd ?? current.length;
    const before = current.slice(0, start), after = current.slice(end);
    const inserted = (separate && before && !/\\s$/.test(before) ? ' ' : '') + text + (separate && after && !/^\\s/.test(after) ? ' ' : '');
    const next = before + inserted + after;
    valueRef.current = next; setValue(next); setAtQuery(null);
    requestAnimationFrame(() => { if (ta?.isConnected) { ta.focus(); ta.setSelectionRange(start + inserted.length, start + inserted.length); ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 200) + 'px'; } });
  }, []);
  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    if (compact) return;
    const plan = getClipboardPastePlan(e.clipboardData);
    if (!plan.shouldPreventDefault) return;
    e.preventDefault(); const target = pasteTarget;
    setPasteStatus({ busy: false, error: '' });
    insertPastedText([plan.text, formatAtMentions(plan.paths)].filter(Boolean).join(' '));
    if (plan.images.length) processImageFiles(normalizeClipboardImages(plan.images));
    if (!plan.others.length) return;
    pendingPastes.current.set(target, (pendingPastes.current.get(target) ?? 0) + 1);
    setPasteStatus({ busy: true, error: '' });
    try {
      const result = await uploadClipboardFiles(plan.others, cwd);
      if (result.errors.length) console.error('[pi-web] file paste failed:', result.errors);
      if (!pasteMountedRef.current || target !== pasteTargetRef.current) {
        console.warn('[pi-web] paste target changed; files saved in original project, not inserted into another draft:', result.uploaded);
        return;
      }
      if (result.uploaded.length) insertPastedText(formatAtMentions(result.uploaded), true);
      if (result.errors.length) setPasteStatus(previous => ({ ...previous, error: [previous.error, ...result.errors].filter(Boolean).join('; ') }));
    } catch (error) {
      console.error('[pi-web] file paste failed:', error);
      if (target === pasteTargetRef.current) setPasteStatus(previous => ({ ...previous, error: error instanceof Error ? error.message : String(error) }));
    } finally {
      const pending = (pendingPastes.current.get(target) ?? 1) - 1;
      if (pending) pendingPastes.current.set(target, pending); else pendingPastes.current.delete(target);
      if (target === pasteTargetRef.current) setPasteStatus(previous => ({ ...previous, busy: pending > 0 }));
    }
  }, [compact, cwd, pasteTarget, processImageFiles, insertPastedText]);`);
  const modelStart = get(input).indexOf('            {(modelOptions.length > 0 || model || modelError)');
  const modelEnd = get(input).indexOf('\n          </div>', modelStart);
  if (modelStart < 0 || modelEnd < 0) throw new Error('native model toolbar missing');
  const modelJsx = get(input).slice(modelStart, modelEnd);
  change(input, modelJsx, '            <PortableFollowup disabled={isStreaming} run={onBuiltinCommand} load={onLoadSlashCommands} />');
  change(input, '            {!isStreaming && onThinkingLevelChange && (', `${modelJsx}\n            {!isStreaming && onThinkingLevelChange && (`);
  change(input, '{!isStreaming && onToolPresetChange && (', '{false && onToolPresetChange && (');
  change(input, '{onSoundToggle !== undefined && (', '{false && onSoundToggle !== undefined && (');
  change(input, '            onPaste={handlePaste}', '            onPaste={handlePaste}');
  change(input, '      <ModelErrorBanner error={modelError} />', '      {(pasteStatus.busy || pasteStatus.error) && <div className="pw-paste-status" role={pasteStatus.error ? "alert" : "status"}>{pasteStatus.error ? `文件粘贴失败：${pasteStatus.error}` : "正在粘贴文件…"}</div>}\n      <ModelErrorBanner error={modelError} />');
  change('components/ModelSelector.tsx', 'aria-label={ariaLabel}', 'aria-label={ariaLabel ?? `当前模型：${currentName}`}', 2);
  change('components/ModelSelector.tsx', 'sortedOptions.length > 0 || onClear ? "Change model"', 'sortedOptions.length > 0 || onClear ? `当前模型：${currentName}`');
  const tools = 'lib/tool-preset-preference.ts';
  const toolStart = get(tools).indexOf('export function getPreferredToolPreset(');
  const toolEnd = get(tools).indexOf('\nexport function setPreferredToolPreset', toolStart);
  change(tools, get(tools).slice(toolStart, toolEnd), 'export function getPreferredToolPreset(): ToolPreset { return "full"; }\n');
  change('hooks/useAudio.ts', '    if (typeof window === "undefined") return true;\n    const stored = localStorage.getItem("pi-sound-enabled");\n    return stored === null ? true : stored === "true";', '    return false;');

  prepend(chat, 'import { PortableNodes } from "./PortableNodes";\nimport { PortableScrollBottom } from "./PortableControls";\n');
  change(chat, 'export function ChatWindow({ session, searchTarget, onSearchTargetHandled,', 'export function ChatWindow({ session, searchTarget: externalSearchTarget, onSearchTargetHandled: externalSearchHandled,');
  const headerEnd = get(chat).indexOf('}: Props) {', get(chat).indexOf('export function ChatWindow('));
  if (headerEnd < 0) throw new Error('ChatWindow props end missing');
  const at = headerEnd + '}: Props) {'.length;
  set(chat, get(chat).slice(0, at) + `
  const [nodeTarget, setNodeTarget] = useState<Props['searchTarget']>(null);
  const searchTarget = nodeTarget ?? externalSearchTarget;
  const onSearchTargetHandled = useCallback((target: { sessionId: string; entryId: string }) => {
    setNodeTarget(null); externalSearchHandled?.(target);
  }, [externalSearchHandled]);
` + get(chat).slice(at));
  const minimapStart = get(chat).indexOf('        {isMobile || pendingScrollRestore ? null : (\n          <ChatMinimap');
  const minimapEnd = get(chat).indexOf('\n        </>}', minimapStart);
  if (minimapStart < 0 || minimapEnd < 0) throw new Error('native minimap mount missing');
  change(chat, get(chat).slice(minimapStart, minimapEnd), `        <PortableScrollBottom container={scrollContainerRef} />
        <PortableNodes sessionId={session?.id ?? sessionIdRef.current ?? undefined} leafId={activeLeafId} messages={messages} entryIds={entryIds} onSelect={entryId => {
          const sessionId = session?.id ?? sessionIdRef.current;
          if (sessionId) setNodeTarget({ sessionId, entryId });
        }} />`);

  change(chat, '                const processViews: ReactNode[] = [];', '                const processViews: ReactNode[] = [];\n                const portableToolViews: ReactNode[] = [];');
  change(chat, '                  const message = processIdx === finalAssistantIdx', '                  const originalProcessMessage = processIdx === finalAssistantIdx');
  change(chat, '                  const blocks = getDisplayableAssistantBlocks(message);', `                  const hasTools = originalProcessMessage.content.some(block => block.type === 'toolCall');
                  if (hasTools) portableToolViews.push(renderMessage(processIdx, {
                    attachRef: false, keyPrefix: 'portable-tools', showTimestamp: false,
                    messageOverride: withAssistantBlocks(originalProcessMessage, originalProcessMessage.content.map(block => block.type === 'toolCall' ? block : { type: 'text', text: '' })),
                  }));
                  // Preserve indices for deferred thinking, but do not render tool
                  // cards twice when the native process group is expanded.
                  const message = hasTools ? withAssistantBlocks(originalProcessMessage, originalProcessMessage.content.map(block => block.type === 'toolCall' ? { type: 'text', text: '' } : block)) : originalProcessMessage;
                  const blocks = getDisplayableAssistantBlocks(message);`);
  change(chat, '                if (processViews.length > 0) {', '                rendered.push(...portableToolViews);\n                if (processViews.length > 0) {');

  const context = 'app/api/sessions/[id]/context/route.ts';
  prepend(context, 'import { collectConversationNodeRecords } from "@/lib/pi-portable-runtime.js";\n');
  change(context, '    // `before` is the oldest entry already on the client;', `    if (url.searchParams.get('nodes') === '1') {
      const branch = sm.getBranch(leafId).filter(entry => entry.type === 'message');
      const records = collectConversationNodeRecords(branch.map(entry => entry.message), branch.map(entry => entry.id));
      const nodes = records.map(({ role, text, fullText, entryId }) => ({ role, text, fullText, entryId }));
      return NextResponse.json({ nodes }, { headers: { 'Cache-Control': 'no-store' } });
    }
    // \`before\` is the oldest entry already on the client;`);
  change(context, '  } catch (error) {\n    return NextResponse.json', '  } catch (error) {\n    console.error("[pi-web] conversation context failed:", error);\n    return NextResponse.json');
  const pkg = JSON.parse(get('package.json'));
  pkg.piPortable = { upstreamRef: upstream.ref, sourceOverlay: 1 };
  set('package.json', JSON.stringify(pkg, null, 2) + '\n');
  return files;
}

function backup(file) {
  const label = 'source-' + sha(file).slice(0, 10);
  const output = execFileSync(process.execPath, [path.join(repo, 'tools/backup.mjs'), file, '--label', label], { encoding: 'utf8', windowsHide: true });
  const match = output.match(/ -> (.+) \d+B sha=/u);
  if (!match) throw new Error(`backup readback missing: ${file}`);
  return match[1];
}
export function patchSource(root, { check = false } = {}) {
  root = path.resolve(root);
  const actualRef = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true, timeout: 10000 }).trim();
  if (actualRef !== upstream.ref) throw new Error(`upstream commit mismatch: expected ${upstream.ref}, got ${actualRef}`);
  const stateFile = path.join(root, '.pi-portable-overlay.json');
  const previous = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null;
  if (previous && previous.upstream !== upstream.ref) throw new Error('previous overlay uses another upstream base; use a matching clean checkout');
  const bases = new Map();
  for (const [name, record] of Object.entries(previous?.files || {})) {
    const file = path.join(root, name);
    if (!fs.existsSync(file) || sha(fs.readFileSync(file)) !== record.patchedSha) throw new Error(`${name}: unknown edit after last overlay; refusing overwrite`);
  }
  const getFile = name => {
    const file = path.join(root, name), record = previous?.files[name];
    if (record) {
      if (sha(fs.readFileSync(file)) !== record.patchedSha) throw new Error(`${name}: unknown edit after last overlay; preserve it before upgrade`);
      if (!record.backup) throw new Error(`${name}: generated file cannot be used as an upstream base`);
      const original = fs.readFileSync(record.backup, 'utf8');
      if (sha(original) !== record.baseSha) throw new Error(`${name}: upstream backup hash mismatch`);
      bases.set(name, original); return original;
    }
    const original = fs.readFileSync(file, 'utf8'); bases.set(name, original); return original;
  };
  const version = JSON.parse(getFile('package.json')).version;
  if (version !== upstream.version) throw new Error(`expected pi-web ${upstream.version}, got ${version}`);
  const files = integrate(getFile);
  const changed = [...files].filter(([name, content]) => !fs.existsSync(path.join(root, name)) || normalize(fs.readFileSync(path.join(root, name), 'utf8')) !== content);
  if (check || changed.length === 0) return { checked: check, changed: changed.map(([name]) => name), upstream: upstream.ref };
  const records = { ...(previous?.files || {}) };
  // Protect all existing targets first. Any failed backup aborts before writes.
  for (const [name] of changed) {
    const file = path.join(root, name);
    if (fs.existsSync(file)) {
      const saved = backup(file);
      if (!records[name]) records[name] = { backup: saved, baseSha: sha(bases.get(name) ?? fs.readFileSync(saved, 'utf8')) };
    } else records[name] = { backup: null, baseSha: null };
  }
  if (fs.existsSync(stateFile)) backup(stateFile);
  for (const [name, content] of changed) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content);
    if (fs.readFileSync(file, 'utf8') !== content) throw new Error(`${name}: readback mismatch`);
    records[name].patchedSha = sha(content);
  }
  fs.writeFileSync(stateFile, JSON.stringify({ upstream: upstream.ref, files: records }, null, 2) + '\n');
  return { changed: changed.map(([name]) => name), upstream: upstream.ref };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--source');
  if (at < 0) throw new Error('usage: patch-piweb-source.mjs --source <official checkout> [--check]');
  try { console.log(JSON.stringify(patchSource(process.argv[at + 1], { check: process.argv.includes('--check') }))); }
  catch (error) { console.error('[pi-web source overlay] refused:', error.message); process.exitCode = 1; }
}
