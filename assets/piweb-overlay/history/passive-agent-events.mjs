// A subscriber may wait for an explicitly started agent; subscribing never starts it.
const key = Symbol.for('pi-web.passive-agent-waiters.v1');
const waiters = globalThis[key] ??= new Map();
export function notifyAgentAvailable(session) {
  const id = session.sessionId;
  for (const notify of [...(waiters.get(id) ?? [])]) notify(session);
}
export function waitForAgent(id, getSession, signal) {
  let finish = () => {};
  const promise = new Promise((resolve, reject) => {
    let done = false;
    const callbacks = waiters.get(id) ?? new Set(); waiters.set(id, callbacks);
    const cleanup = () => { callbacks.delete(available); if (!callbacks.size && waiters.get(id) === callbacks) waiters.delete(id); signal.removeEventListener('abort', abort); };
    const available = session => { if (done || !session?.isAlive()) return; done = true; cleanup(); resolve(session); };
    const abort = () => { if (done) return; done = true; cleanup(); reject(new DOMException('Subscription closed', 'AbortError')); };
    finish = abort; callbacks.add(available); signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort(); else available(getSession(id));
  });
  return { promise, cancel: () => finish() };
}
export function pendingAgentSubscriptions() { return [...waiters.values()].reduce((n, set) => n + set.size, 0); }
