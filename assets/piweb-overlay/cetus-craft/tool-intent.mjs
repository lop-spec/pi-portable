// Craft Agents metadata contract, adapted to Pi's native tool registry.
// Metadata stays in assistant history; only the execution copy is stripped.
export const displayNameSchema = { type: 'string', description: '用8～16字中文说这步做什么，小学生也能懂；如“查画面在哪里被放大”。不另写重复旁白。' };
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
  const { _displayName, _intent, ...properties } = schema.properties ?? {};
  return { ...tool, [installed]: true,
    parameters: { ...schema, properties: { _displayName: displayNameSchema, ...properties }, required: [...new Set(['_displayName', ...(schema.required || []).filter(key => key !== '_intent')])] },
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
