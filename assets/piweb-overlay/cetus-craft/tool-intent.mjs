// Craft Agents metadata contract, adapted to Pi's native tool registry.
// Metadata stays in assistant history; only the execution copy is stripped.
export const intentSchema = { type: 'string', description: 'REQUIRED: Describe what you are trying to accomplish with this tool call (1-2 sentences)' };
export const displayNameSchema = { type: 'string', description: 'REQUIRED: Human-friendly name for this action (2-4 words, e.g., "List Folders", "Search Documents", "Create Task")' };
const installed = Symbol.for('pi-web.craft-tool-intent');
export function withoutMetadata(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  const { _intent, _displayName, ...input } = args;
  return input;
}
export function withMetadata(tool) {
  if (tool[installed]) return tool;
  const schema = tool.parameters;
  if (!schema || schema.type !== 'object') return tool;
  return { ...tool, [installed]: true,
    parameters: { ...schema, properties: { _displayName: displayNameSchema, _intent: intentSchema, ...schema.properties }, required: [...new Set(['_displayName', '_intent', ...(schema.required || [])])] },
    execute(id, args, ...rest) { return tool.execute.call(tool, id, withoutMetadata(args), ...rest); },
  };
}
export function installToolIntent(session) {
  const agent = session.agent;
  if (agent[installed]) return;
  const state = agent.state;
  if (!state || !Array.isArray(state.tools)) throw new Error('Pi tool registry unavailable');
  const descriptor = Object.getOwnPropertyDescriptor(state, 'tools');
  if (descriptor && !descriptor.configurable) throw new Error('Pi tool registry is not configurable');
  let tools = state.tools;
  Object.defineProperty(state, 'tools', {
    configurable: true, enumerable: true,
    get() { return descriptor?.get ? descriptor.get.call(state) : tools; },
    set(next) {
      const decorated = next.map(withMetadata);
      if (descriptor?.set) descriptor.set.call(state, decorated);
      else tools = decorated;
    },
  });
  state.tools = tools;
  agent[installed] = true;
  // SDK validation clones arguments before this hook; the model message is untouched.
  const before = agent.beforeToolCall;
  agent.beforeToolCall = function(event) {
    if (event.args && typeof event.args === 'object') {
      delete event.args._intent;
      delete event.args._displayName;
    }
    return before?.call(this, event);
  };
}
