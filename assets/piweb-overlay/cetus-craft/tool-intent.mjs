// Craft Agents metadata contract, adapted to Pi's native tool registry.
// Metadata stays in assistant history; only the execution copy is stripped.
export const phaseSchema = { type: 'string', description: '仅开始新阶段时填一句中文人话，如“核对修改后的效果”；同阶段后续调用省略，不另写重复旁白。' };
const installed = Symbol.for('pi-web.craft-tool-intent');
export function withoutMetadata(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  const { _intent, _displayName, _phase, ...input } = args;
  return input;
}
export function withMetadata(tool) {
  if (tool[installed]) return tool;
  const schema = tool.parameters;
  if (!schema || schema.type !== 'object') return tool;
  const { _displayName, _intent, _phase, ...properties } = schema.properties ?? {};
  return { ...tool, [installed]: true,
    parameters: { ...schema, properties: { _phase: phaseSchema, ...properties }, required: (schema.required || []).filter(key => !['_displayName', '_intent', '_phase'].includes(key)) },
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
      delete event.args._phase;
    }
    return before?.call(this, event);
  };
}
