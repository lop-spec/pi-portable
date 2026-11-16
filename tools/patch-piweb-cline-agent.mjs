// Cline CLI as a second agent for Pi sessions, chosen per prompt from the composer.
// The session stays Pi's: an inline extension swaps the prompt and the file/shell tools
// for Cline's during a run and hands those tool calls to a Cline process. See
// docs/cline-agent.md.
const CSS = `.pw-agent-switch { display: inline-flex; flex: none; align-items: center; gap: 2px; height: var(--control-h); padding: 2px; border-radius: var(--r-md); background: var(--bg-hover); }
.pw-agent-switch > button { height: 100%; padding: 0 8px; border: 0; border-radius: var(--r-sm); background: transparent; color: var(--text-secondary); font: inherit; font-size: 12.5px; line-height: 1; white-space: nowrap; cursor: pointer; transition: background-color var(--dur) var(--ease), color var(--dur) var(--ease); }
.pw-agent-switch > button:hover { color: var(--text); }
.pw-agent-switch > button[aria-checked="true"] { background: var(--bg); color: var(--text); }
`;

export function integrateClineAgent({ set, change, prepend, template }) {
  set('lib/cline-bridge.ts', template('cline-agent/cline-bridge.ts'));
  set('lib/cline-agent.ts', template('cline-agent/cline-agent.ts'));
  set('lib/portable-agent-choice.ts', template('cline-agent/agent-choice.ts'));
  set('components/PortableAgentSwitch.tsx', template('cline-agent/PortableAgentSwitch.tsx'));
  set('app/api/cline-agent/route.ts', template('cline-agent/route.ts'));

  // Server: one controller per full session; chat-only and subagent sessions stay Pi-only.
  const rpc = 'lib/rpc-manager.ts';
  change(rpc, 'import { createExactSystemPromptExtension } from "./exact-system-prompt";', 'import { createExactSystemPromptExtension } from "./exact-system-prompt";\nimport { createClineAgent, type ClineAgent } from "./cline-agent";');
  change(rpc, '  suppressCompletionNotifications?: boolean;\n};', '  suppressCompletionNotifications?: boolean;\n  clineAgent?: ClineAgent;\n};');
  change(rpc, '  private readonly suppressCompletionNotifications: boolean;', '  private readonly suppressCompletionNotifications: boolean;\n  private readonly clineAgent?: ClineAgent;');
  change(rpc, '    this.suppressCompletionNotifications = options.suppressCompletionNotifications ?? false;', '    this.suppressCompletionNotifications = options.suppressCompletionNotifications ?? false;\n    this.clineAgent = options.clineAgent;');
  change(rpc, '      case "prompt": {\n        // Serialize only admission.', '      case "prompt": {\n        if (typeof command.agent === "string") this.clineAgent?.setAgent(command.agent);\n        // Serialize only admission.');
  change(rpc, '    const usesExactSystemPrompt = chatOnly || subagentResources?.exactSystemPrompt !== undefined;', '    const usesExactSystemPrompt = chatOnly || subagentResources?.exactSystemPrompt !== undefined;\n    const clineAgent = chatOnly || subagentResources ? undefined : createClineAgent(sessionCwd);');
  change(rpc, '                isBuiltInSubagentsEnabled,\n              ),\n            ],', '                isBuiltInSubagentsEnabled,\n              ),\n              ...(clineAgent ? [clineAgent.extension] : []),\n            ],');
  change(rpc, '      suppressCompletionNotifications: Boolean(subagentResources),\n    });', '      suppressCompletionNotifications: Boolean(subagentResources),\n      ...(clineAgent ? { clineAgent } : {}),\n    });');

  // Client: every prompt names its agent; the switch sits with the model controls.
  const client = 'lib/agent-client.ts';
  prepend(client, 'import { agentForPrompt } from "./portable-agent-choice";\n');
  change(client, '    body: JSON.stringify(command),', '    body: JSON.stringify(command.type === "prompt" ? { ...command, agent: agentForPrompt(sessionId) } : command),');
  const input = 'components/ChatInput.tsx';
  prepend(input, 'import { PortableAgentSwitch } from "./PortableAgentSwitch";\n');
  change(input, '              <span className="pw-composer-vsep" aria-hidden="true" />\n              {!imageMode && (modelOptions.length > 0 || model || modelError) && onModelChange && (', '              <span className="pw-composer-vsep" aria-hidden="true" />\n              {!imageMode && !compact && <PortableAgentSwitch sessionKey={providedDraftKey} />}\n              {!imageMode && (modelOptions.length > 0 || model || modelError) && onModelChange && (');
  change('app/redesign-chrome.css', '.pw-composer-chip {\n', `${CSS}.pw-composer-chip {\n`);
}
