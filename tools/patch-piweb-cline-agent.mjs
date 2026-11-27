// Cline CLI as a second agent for Pi sessions, chosen per prompt from the composer.
// The session stays Pi's: an inline extension swaps the prompt and the file/shell tools
// for Cline's during a run and hands those tool calls to a Cline process. See
// docs/cline-agent.md.
export function integrateClineAgent({ set, change, prepend, template }) {
  set('lib/cline-bridge.ts', template('cline-agent/cline-bridge.ts'));
  set('lib/opencode-launch.ts', template('cline-agent/opencode-launch.ts'));
  set('lib/cline-prompt-cache.ts', template('cline-agent/cline-prompt-cache.ts'));
  set('lib/cline-agent.ts', template('cline-agent/cline-agent.ts'));
  set('lib/portable-agent-choice.ts', template('cline-agent/agent-choice.ts'));
  set('components/PortableAgentSwitch.tsx', template('cline-agent/PortableAgentSwitch.tsx'));
  set('components/DefaultAgentSetting.tsx', template('cline-agent/DefaultAgentSetting.tsx'));
  const defaults = 'components/DefaultSessionSettings.tsx';
  prepend(defaults, 'import { DefaultAgentSetting } from "./DefaultAgentSetting";\n');
  change(defaults, '    <h3 className="settings-general-heading">会话默认</h3>', '    <h3 className="settings-general-heading">会话默认</h3>\n    <DefaultAgentSetting />');
  set('app/api/cline-agent/route.ts', template('cline-agent/route.ts'));

  // Server: one controller per full session; chat-only and subagent sessions stay Pi-only.
  const rpc = 'lib/rpc-manager.ts';
  change(rpc, 'import { createExactSystemPromptExtension } from "./exact-system-prompt";', 'import { createExactSystemPromptExtension } from "./exact-system-prompt";\nimport { createClineAgent, type ClineAgent } from "./cline-agent";');
  change(rpc, '  suppressCompletionNotifications?: boolean;\n};', '  suppressCompletionNotifications?: boolean;\n  clineAgent?: ClineAgent;\n};');
  change(rpc, '  private readonly suppressCompletionNotifications: boolean;', '  private readonly suppressCompletionNotifications: boolean;\n  private readonly clineAgent?: ClineAgent;');
  change(rpc, '    this.suppressCompletionNotifications = options.suppressCompletionNotifications ?? false;', '    this.suppressCompletionNotifications = options.suppressCompletionNotifications ?? false;\n    this.clineAgent = options.clineAgent;');
  change(rpc, '        const releaseAdmission = await this.acquirePromptAdmission();\n        try {', '        const releaseAdmission = await this.acquirePromptAdmission();\n        try {\n          if (typeof command.agent === "string") this.clineAgent?.setAgent(command.agent);');
  change(rpc, '    const usesExactSystemPrompt = chatOnly || subagentResources?.exactSystemPrompt !== undefined;', '    const usesExactSystemPrompt = chatOnly || subagentResources?.exactSystemPrompt !== undefined;\n    const clineAgent = chatOnly || subagentResources ? undefined : createClineAgent(sessionCwd);');
  change(rpc, '                isBuiltInSubagentsEnabled,\n              ),\n            ],', '                isBuiltInSubagentsEnabled,\n              ),\n              ...(clineAgent ? [clineAgent.extension] : []),\n            ],');
  change(rpc, '      suppressCompletionNotifications: Boolean(subagentResources),\n    });', '      suppressCompletionNotifications: Boolean(subagentResources),\n      ...(clineAgent ? { clineAgent } : {}),\n    });');

  // Client: every prompt names its agent; the switch sits with the model controls.
  const client = 'lib/agent-client.ts';
  prepend(client, 'import { agentForPrompt } from "./portable-agent-choice";\n');
  change(client, '    body: JSON.stringify(command),', '    body: JSON.stringify(command.type === "prompt" ? { ...command, agent: await agentForPrompt(sessionId) } : command),');
  const sessionHook = 'hooks/useAgentSession.ts';
  prepend(sessionHook, 'import { moveAgentChoice } from "@/lib/portable-agent-choice";\n');
  change(sessionHook, '      const realId = result.sessionId;\n      sessionIdRef.current = realId;', '      const realId = result.sessionId;\n      moveAgentChoice(newSessionDraftKey, realId);\n      sessionIdRef.current = realId;');
  change(sessionHook, '}, [isNew, newSessionCwd, toolPreset, newSessionDefaultThinkingLevel]);', '}, [isNew, newSessionCwd, newSessionDraftKey, toolPreset, newSessionDefaultThinkingLevel]);');
  const input = 'components/ChatInput.tsx';
  prepend(input, 'import { PortableAgentSwitch } from "./PortableAgentSwitch";\n');
  change(input, '              <span className="pw-composer-vsep" aria-hidden="true" />\n              {!imageMode && (modelOptions.length > 0 || model || modelError) && onModelChange && (', '              <span className="pw-composer-vsep" aria-hidden="true" />\n              {!imageMode && !compact && <PortableAgentSwitch sessionKey={providedDraftKey} />}\n              {!imageMode && (modelOptions.length > 0 || model || modelError) && onModelChange && (');
}
