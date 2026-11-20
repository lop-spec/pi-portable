// Final source integration for global defaults and per-session deliverables.
export function integrateSessionExperience({get,set,change,prepend,template}) {
  for (const [target,source] of [
    ['components/DefaultSessionSettings.tsx','DefaultSessionSettings.tsx'],
    ['components/SessionArtifacts.tsx','SessionArtifacts.tsx'],
    ['app/session-experience.css','session-experience.css'],
    ['lib/session-artifacts.mjs','session-artifacts.mjs'],
    ['lib/artifacts-popover-placement.mjs','popover-placement.mjs'],
    ['lib/session-defaults-store.mjs','defaults-store.mjs'],
    ['app/api/session-defaults/route.ts','defaults-route.ts'],
    ['app/api/sessions/[id]/artifacts/route.ts','artifacts-route.ts'],
  ]) set(target,template('session-experience/'+source));

  const settings='components/SettingsPanel.tsx';
  prepend(settings,'import { DefaultSessionSettings } from "./DefaultSessionSettings";\n');
  change(settings,'function GeneralSettings({ sessionId, onSessionReloaded, quoteSelectionEnabled, onQuoteSelectionChange }: Pick<Props, "sessionId" | "onSessionReloaded" | "quoteSelectionEnabled" | "onQuoteSelectionChange">)',
    'function GeneralSettings({ cwd, sessionId, onSessionReloaded, quoteSelectionEnabled, onQuoteSelectionChange }: Pick<Props, "cwd" | "sessionId" | "onSessionReloaded" | "quoteSelectionEnabled" | "onQuoteSelectionChange">)');
  change(settings,'      <AutoArchiveSetting />','      <DefaultSessionSettings cwd={cwd} />\n      <AutoArchiveSetting />');
  change(settings,'<GeneralSettings sessionId={sessionId}', '<GeneralSettings cwd={cwd} sessionId={sessionId}');

  const app='components/AppShell.tsx';
  prepend(app,'import { SessionArtifacts } from "./SessionArtifacts";\n');
  const src=get(app), start=src.indexOf('  const renderChatToolbarActions = (mobile: boolean) => {');
  const open=src.indexOf('      <div className={mobile ? "pw-tb-actions is-mobile" : "pw-tb-actions"}>',start);
  const keep=src.indexOf('        {hasSubagentSessions && (',open);
  const sys=src.indexOf('        <button\n          ref={systemBtnRef}',keep);
  const end=src.indexOf('      </div>\n    );\n  };',sys);
  if([start,open,keep,sys,end].some(n=>n<0))throw new Error('Toolbar anchors missing; zero writes');
  const header='      <div className={mobile ? "pw-tb-actions is-mobile" : "pw-tb-actions"}>';
  const next=src.slice(0,open)+header+'\n        <SessionArtifacts sessionId={selectedSession?.id ?? null} onOpenFile={handleOpenLinkedFile} mobile={mobile} />\n'+src.slice(keep,sys)+src.slice(end);
  set(app,next);

  const names='lib/tool-names.ts';
  change(names,'  return name === "edit" ||','  return name === "edit" || name === "editor" || name.endsWith(".editor") || name.endsWith("_editor") ||');

  const hook='hooks/useAgentSession.ts';
  change(hook,'  const thinkingLevelOverrideRef = useRef<ConcreteThinkingLevel | null>(null);','  const thinkingLevelOverrideRef = useRef<ConcreteThinkingLevel | null>(null);\n  const explicitDraftThinkingRef = useRef(false);');
  change(hook,'    defaultThinkingLevelRef.current = asConcreteThinkingLevel(d.defaultThinkingLevel);','    defaultThinkingLevelRef.current = asConcreteThinkingLevel(d.defaultThinkingLevel);\n    if (isNew && !sessionIdRef.current && !explicitDraftThinkingRef.current && defaultThinkingLevelRef.current) {\n      thinkingLevelOverrideRef.current = defaultThinkingLevelRef.current;\n      setNewSessionThinkingLevel(defaultThinkingLevelRef.current);\n    }');
  change(hook,'  const handleThinkingLevelChange = useCallback(async (level: ThinkingLevelOption) => {','  const handleThinkingLevelChange = useCallback(async (level: ThinkingLevelOption) => {\n    if (isNew) explicitDraftThinkingRef.current = true;');

  const route='app/api/agent/[id]/route.ts';
  prepend(route,'import { getAgentDir } from "@earendil-works/pi-coding-agent";\nimport { readSessionDefaults, planSessionDefaults } from "@/lib/session-defaults-store.mjs";\nimport { openSessionManager } from "@/lib/session-reader";\n');
  change(route,'// POST /api/agent/[id] - Send a command to an existing session',`async function applySessionDefaults(session: NonNullable<ReturnType<typeof getRpcSession>>, plan: {model?: {provider:string;modelId:string};thinking?:string}, modelAlreadySet = false) {
  if (plan.model && !modelAlreadySet) await session.send({type:"set_model",...plan.model});
  if (plan.thinking) await session.send({type:"set_thinking_level",level:plan.thinking});
}

// POST /api/agent/[id] - Send a command to an existing session`);
  change(route,'    if (existing?.isAlive()) {\n      const result = await existing.send(body);',`    if (existing?.isAlive()) {
      if (body.type === "prompt" && !existing.isRunning()) {
        const plan = planSessionDefaults(existing.inner.sessionManager.getBranch(),readSessionDefaults(getAgentDir()));
        await applySessionDefaults(existing, plan);
      }
      const result = await existing.send(body);`);
  change(route,'    const { session } = await startRpcSession(id, filePath, undefined, {',`    const plan = body.type === "prompt" ? planSessionDefaults(openSessionManager(filePath).getBranch(),readSessionDefaults(getAgentDir())) : {};
    const { session } = await startRpcSession(id, filePath, undefined, {`);
  change(route,'      ...(body.type === "set_model"\n        ? { replacementModel: { provider: body.provider as string, modelId: body.modelId as string } }\n        : {}),',`      ...(body.type === "set_model"
        ? { replacementModel: { provider: body.provider as string, modelId: body.modelId as string } }
        : plan.model ? { replacementModel: plan.model } : {}),`);
  change(route,'    const result = await session.send(body);','    if (body.type === "prompt") await applySessionDefaults(session, plan, Boolean(plan.model));\n    const result = await session.send(body);');
}
