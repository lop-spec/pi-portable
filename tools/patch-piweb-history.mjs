// Applied after the pinned redesign, never to compiled chunks.
import { createHash } from 'node:crypto';
export function integrateHistory({ get, set, change, prepend, template }) {
  for (const name of ['session-disk-reader.mjs', 'passive-agent-events.mjs', 'ui-message.mjs']) set(`lib/${name}`, template(`history/${name}`));
  set('app/api/sessions/[id]/entries/[entryId]/route.ts', template('history/entry-route.ts'));

  // Read-only subscriptions attach to future explicit starts, without creating an Agent.
  const events = 'app/api/agent/[id]/events/route.ts';
  prepend(events, 'import { waitForAgent } from "@/lib/passive-agent-events.mjs";\n');
  change(events, 'getRpcSession, startRpcSession', 'getRpcSession');
  const ev = get(events), a = ev.indexOf('  // Fast path: already-running session'), b = ev.indexOf('\n  return new Response(stream,', a);
  if (a < 0 || b < a) throw new Error('events subscription anchor missing');
  change(events, ev.slice(a, b), `  const session = getRpcSession(id);
  if (!session?.isAlive() && !await resolveSessionPath(id)) return new Response("Session not found", { status: 404 });
  const waiting = waitForAgent(id, getRpcSession, req.signal);
  const stream = createAgentEventStream(req, id, waiting.promise, {
    idle: !session?.isAlive(), onClose: waiting.cancel,
  });
`);
  const rpc = 'lib/rpc-manager.ts';
  prepend(rpc, 'import { notifyAgentAvailable } from "@/lib/passive-agent-events.mjs";\n');
  change(rpc, '  registry.set(sessionId, wrapper);\n  wrapper.start();', '  registry.set(sessionId, wrapper);\n  wrapper.start();\n  notifyAgentAvailable(wrapper);');
  const stream = 'lib/agent-event-stream.ts';
  prepend(stream, 'import { uiMessage } from "./ui-message.mjs";\n');
  change(stream, '  sessionPromise: Promise<AgentEventStreamSession>,\n', '  sessionPromise: Promise<AgentEventStreamSession>,\n  options: { idle?: boolean; onClose?: () => void } = {},\n');
  change(stream, '        closed = true;\n        releaseLease();', '        closed = true;\n        options.onClose?.();\n        releaseLease();');
  change(stream, '      void publishSession();', '      if (options.idle) encode({ type: "connected", sessionId, isStreaming: false, idle: true });\n      void publishSession();');
  change(stream, 'encode({ type: "message_start", message: snapshot });', 'encode({ type: "message_start", message: uiMessage(snapshot) });');
  const wire = 'lib/agent-event-wire.ts';
  prepend(wire, 'import { uiMessage } from "./ui-message.mjs";\n');
  change(wire, '  return event;\n}', '  if ((event.type === "message_start" || event.type === "message_end") && isObject(event.message)) { const message = uiMessage(event.message); return message === event.message ? event : { ...event, message }; }\n  return event;\n}');

  const reader = 'lib/session-reader.ts';
  prepend(reader, 'import { uiMessage } from "./ui-message.mjs";\n');
  set(reader, get(reader) + `\nfunction entryLocationQuery(entry: object): string {\n  const p = (entry as { [key: symbol]: { start: number; length: number } | undefined })[Symbol.for("pi-web.entry-location")];\n  return p ? \`&offset=\${p.start}&length=\${p.length}\` : "";\n}\n`);
  change(reader, 'if (m && toolResults) m = toChatViewMessage(m, toolResults, options.cwd);', `if (m && toolResults) {
      m = toChatViewMessage(m, toolResults, options.cwd);
      const location = entryLocationQuery(entry);
      const entryUrl = options.sessionId ? \`/api/sessions/\${encodeURIComponent(options.sessionId)}/entries/\${encodeURIComponent(entry.id)}\${location ? "?" + location.slice(1) : ""}\` : undefined;
      if (entryUrl && m.role === "assistant") m = { ...m, content: m.content.map(block => block.type === "toolCall" ? { ...block, chatView: { ...(block as unknown as { chatView?: object }).chatView, entryUrl } } : block) } as AgentMessage;
      if (entryUrl && m.role === "toolResult") m = { ...m, chatView: { ...(m as unknown as { chatView?: object }).chatView, entryUrl } } as AgentMessage;
    }
    if (m?.role === "assistant") m = { ...m, content: m.content.map(block => block.type === "thinking" && block.deferred ? { ...block, entryQuery: entryLocationQuery(entry) } : block) } as AgentMessage;`);
  change(reader, 'const keepDetails = isApplyPatchToolName(result.toolName ?? "");', 'const keepDetails = false; // full details belong to the explicit entry endpoint');
  change(reader, '...(result.isError !== undefined ? { isError: result.isError } : {}),', 'isError: Boolean(result.isError) || (isApplyPatchToolName(result.toolName ?? "") && applyPatchResultHasFailures(result.details)),');
  change(reader, '  if (message.role !== "toolResult") return message;', '  if (!("content" in message) || !Array.isArray(message.content)) return message;');
  change(reader, '  entryId: string,\n): AgentMessage {', '  entryId: string,\n  entryQuery = "",\n): AgentMessage {');
  change(reader, 'deferToolResultBase64Images(normalizeToolCalls(entry.message), options.sessionId, entry.id)', 'deferToolResultBase64Images(normalizeToolCalls(entry.message), options.sessionId, entry.id, entryLocationQuery(entry))');
  change(reader, 'tool-result-image?blockIndex=${blockIndex}`', 'tool-result-image?blockIndex=${blockIndex}${entryQuery}`');
  change(reader, '  const content = message.content.flatMap((block, blockIndex) => {', '  const content = (message.content as unknown[]).flatMap<import("./types").AssistantContentBlock>((block, blockIndex) => {');
  change(reader, '    if (!image) return [block];', '    if (!image) return [block as import("./types").AssistantContentBlock];');
  change(reader, 'return { ...message, content };', 'return { ...message, content } as AgentMessage;', 2);
  change(reader, 'if (!options.deferThinking || message.role !== "assistant") return message;', 'message = uiMessage(message) as AgentMessage;\n      if (!options.deferThinking || message.role !== "assistant") return message;');

  const detail = 'app/api/sessions/[id]/route.ts';
  prepend(detail, 'import { openDiskSession, diskViewRevision } from "@/lib/session-disk-reader.mjs";\n');
  const tailDef = '    const rawTail = Number(searchParams.get("tail"));\n    const tail = Number.isFinite(rawTail) && rawTail > 0 ? Math.min(rawTail, 1000) : 50;\n';
  change(detail, tailDef, '');
  change(detail, '    const sm = liveRpc?.inner.sessionManager ?? openSessionManager(resolvedPath!);', `${tailDef}    const diskRevision = !liveRpc && resolvedPath && searchParams.get("view") === "chat" ? await diskViewRevision(resolvedPath) : null;
    if (diskRevision && req.headers.get("If-None-Match") === \`"\${diskRevision}"\`) return new Response(null, { status: 304, headers: { ETag: \`"\${diskRevision}"\`, "Cache-Control": "private, no-cache" } });
    const diskView = !liveRpc && searchParams.get("view") === "chat"
      ? await openDiskSession(resolvedPath!, { tail, metadata: searchParams.get("metadata") === "1" }) : null;
    const sm = liveRpc?.inner.sessionManager ?? diskView ?? openSessionManager(resolvedPath!);`);
  change(detail, '    const entries = sm.getEntries();', '    const entries = sm.getEntries() as unknown as SessionEntry[];');
  change(detail, '    perf?.span("context");', `    perf?.span("context");
    if (diskView?.metadataPending) return jsonResponse(req, {
      sessionId: id, filePath, info: null, leafId, tree: [], treeFormat: "summary", snapshotRevision: null,
      context, totalActiveMs: 0, metadataPending: true,
    });`);
  change(detail, 'const snapshotRevision = computeSessionRevision({', 'const snapshotRevision = diskView?.revision ?? computeSessionRevision({');
  const dd = get(detail), start = dd.indexOf('    return perf?.attach(jsonResponse('), end = dd.indexOf('\n  } catch (error)', start);
  if (start < 0 || end < start) throw new Error('detail response anchor missing');
  change(detail, dd.slice(start, end), `    const response = jsonResponse(req, {
      sessionId: id, filePath, info, leafId, tree,
      ...(summaryTree ? { treeFormat: "summary" as const } : {}), snapshotRevision, context, stats, totalActiveMs,
      ...(toolNames !== undefined ? { toolNames } : {}), ...(wrapperRebuilt ? { wrapperRebuilt: true } : {}),
    }, { headers: snapshotRevision ? { ETag: \`"\${snapshotRevision}"\`, "Cache-Control": "private, no-cache" } : {} });
    return perf?.attach(response) ?? response;`);

  const context = 'app/api/sessions/[id]/context/route.ts';
  prepend(context, 'import { openDiskSession } from "@/lib/session-disk-reader.mjs";\n');
  change(context, 'const sm = liveRpc?.inner.sessionManager ?? openSessionManager(filePath!);', 'const sm = liveRpc?.inner.sessionManager ?? await openDiskSession(filePath!, { leafId, before, tail, nodes: url.searchParams.get("nodes") === "1" });');
  // Single-item reasoning and media reads must not re-open the entire SDK log.
  for (const name of ['thinking', 'tool-result-image']) {
    const route = `app/api/sessions/[id]/entries/[entryId]/${name}/route.ts`;
    prepend(route, 'import { readDiskEntry } from "@/lib/session-disk-reader.mjs";\nimport { getRpcSession } from "@/lib/rpc-manager";\n');
    change(route, 'getSessionEntries, resolveSessionPath', 'resolveSessionPath');
    change(route, 'const entry = getSessionEntries(filePath).find((candidate) => candidate.id === entryId);', 'const live = getRpcSession(id);\n    const entry = live?.isAlive() ? live.inner.sessionManager.getEntry(entryId) : await readDiskEntry(filePath, entryId, new URL(req.url).searchParams);');
    if (name === 'tool-result-image') change(route, 'entry.message.role !== "toolResult"', '!Array.isArray(entry.message.content)');
  }

  const hook = 'hooks/useAgentSession.ts';
  change(hook, '  const loadFlightsRef = useRef(new Map<string, Promise<unknown>>());', '  const loadFlightsRef = useRef(new Map<string, Promise<unknown>>());\n  const loadControllersRef = useRef(new Set<AbortController>());');
  change(hook, 'const flightKey = options?.force ? `force:${sid}` : sid;\n    const inflight = options?.force ? undefined : loadFlightsRef.current.get(flightKey);', 'const flightKey = `${sid}:${includeState ? "state" : "view"}:${options?.force ? "force" : "normal"}`;\n    const inflight = loadFlightsRef.current.get(flightKey);');
  change(hook, '    if (inflight) return await inflight;\n  const flight', '    if (inflight) return await inflight;\n    const controller = new AbortController();\n    loadControllersRef.current.add(controller);\n  const flight');
  change(hook, 'new URLSearchParams({ deferThinking: "1", deferMedia: "1", tree: "summary" })', 'new URLSearchParams({ deferThinking: "1", deferMedia: "1", tree: "summary", view: "chat", tail: "50" })');
  change(hook, 'const res = await fetch(`/api/sessions/${encodeURIComponent(sid)}?${params}`);', `const previous = readSessionViewSnapshot(sid);
      const res = await fetch(\`/api/sessions/\${encodeURIComponent(sid)}?\${params}\`, { signal: controller.signal,
        headers: previous?.revision && dataRef.current?.sessionId === sid && dataRef.current.filePath ? { "If-None-Match": \`"\${previous.revision}"\` } : undefined,
      });`);
  change(hook, '      if (!res.ok) throw new Error(`HTTP ${res.status}`);\n      const d = await res.json() as SessionData;', `      if (!res.ok && res.status !== 304) throw new Error(\`HTTP \${res.status}\`);
      let d: SessionData & { metadataPending?: boolean };
      if (res.status === 304) {
        const cached = readSessionViewSnapshot(sid);
        if (!cached) throw new Error("Session snapshot expired during validation");
        d = { sessionId: sid, filePath: dataRef.current?.filePath ?? "", totalActiveMs: cached.totalActiveMs ?? 0,
          tree: cached.summaryTree as SessionTreeNode[], treeFormat: "summary", leafId: cached.leafId, snapshotRevision: cached.revision,
          context: { messages: cached.messages, entryIds: cached.entryIds, oldestEntryId: cached.oldestEntryId, hasMore: cached.hasMore, thinkingLevel: cached.thinkingLevel, model: cached.model }, stats: cached.stats as SessionFileStats | undefined,
          ...(dataRef.current?.sessionId === sid ? { toolNames: dataRef.current.toolNames } : {}),
        };
      } else d = await res.json() as typeof d;
      if (d.metadataPending) {
        // Paint the tail now. Keep sending disabled until authoritative settings/stats arrive.
        if (sessionIdRef.current === sid && messagesRef.current.length === 0) {
          setData(d); setActiveLeafId(d.leafId); setMessages(d.context.messages); setEntryIds(d.context.entryIds);
          setHistoryCursor(d.context.oldestEntryId); setHasEarlierMessages(d.context.hasMore);
        }
        params.set("metadata", "1");
        const metadataResponse = await fetch(\`/api/sessions/\${encodeURIComponent(sid)}?\${params}\`, { signal: controller.signal });
        if (!metadataResponse.ok) throw new Error(\`HTTP \${metadataResponse.status}\`);
        d = await metadataResponse.json() as typeof d;
      }`);
  change(hook, '    if (!options?.force) loadFlightsRef.current.set(flightKey, flight);', '    loadFlightsRef.current.set(flightKey, flight);');
  change(hook, '      if (loadFlightsRef.current.get(flightKey) === flight) loadFlightsRef.current.delete(flightKey);', '      loadControllersRef.current.delete(controller);\n      if (loadFlightsRef.current.get(flightKey) === flight) loadFlightsRef.current.delete(flightKey);');
  change(hook, '    } catch (e) {\n      setError(String(e));\n      return "error";', '    } catch (e) {\n      if (controller.signal.aborted) return null;\n      setError(String(e));\n      return "error";');
  change(hook, 'new URLSearchParams({ deferThinking: "1", deferMedia: "1" })', 'new URLSearchParams({ deferThinking: "1", deferMedia: "1", view: "chat", tail: "50" })');
  change(hook, '      sessionHookMountedRef.current = false;\n', '      sessionHookMountedRef.current = false;\n      for (const controller of loadControllersRef.current) controller.abort();\n      loadControllersRef.current.clear();\n');
  change(hook, '// Keep the selected session warm even while its agent is idle.', '// Keep the selected session warm even while its agent is idle.\n  // Only the subscription is warm: it never initializes a dormant Agent.');

  const nodes = 'components/PortableNodes.tsx';
  change(nodes, '    // Off the first paint; opening the panel before then loads it right away.\n    const idle = typeof window.requestIdleCallback === "function" ? window.requestIdleCallback(run, { timeout: 3_000 }) : null;\n    const timer = idle === null ? setTimeout(run, 1_500) : null;', '    // Reading history is not permission to preload every question/answer.\n    if (open) run();');
  change(nodes, '      if (idle !== null) window.cancelIdleCallback(idle);\n      if (timer !== null) clearTimeout(timer);\n', '');
  change(nodes, '  }, [sessionId, leafId]);', '  }, [sessionId, leafId, open]);');

  const written = 'lib/turn-written-files.ts';
  change(written, '    const rawPaths = isApplyPatchToolName(block.toolName)\n      ? readApplyPatchPaths(block.input, result)\n      : [readToolPath(block.input)];', `    const view = (block as unknown as { chatView?: { writtenPaths?: string[]; failed?: boolean } }).chatView;
    if (view?.failed) continue;
    const rawPaths = Array.isArray(view?.writtenPaths) ? view.writtenPaths : isApplyPatchToolName(block.toolName)
      ? readApplyPatchPaths(block.input, result)
      : [readToolPath(block.input)];`);

  change('lib/types.ts', '  deferred?: boolean;', '  deferred?: boolean;\n  /** Validated physical-line hint for lazy historical reasoning reads. */\n  entryQuery?: string;');
  change('components/PortableProcessTimeline.tsx', 'portableLoadThinkingContent(sessionId, entryId, blockIndex)', 'portableLoadThinkingContent(sessionId, entryId, blockIndex, block.entryQuery)');
  const message = 'components/MessageView.tsx';
  change(message, 'function loadThinkingContent(sessionId: string, entryId: string, blockIndex: number):', 'function loadThinkingContent(sessionId: string, entryId: string, blockIndex: number, entryQuery = ""):');
  change(message, 'const key = `${sessionId}:${entryId}:${blockIndex}`;', 'const key = `${sessionId}:${entryId}:${blockIndex}:${entryQuery}`;');
  change(message, '/thinking?blockIndex=${blockIndex}`', '/thinking?blockIndex=${blockIndex}${entryQuery}`');
  change(message, 'loadThinkingContent(sessionId, entryId, blockIndex)', 'loadThinkingContent(sessionId, entryId, blockIndex, block.entryQuery)');
  change(message, 'function ToolCallBlock({ block, result, duration, onOpenSession }:', 'function ToolCallBlock({ block: previewBlock, result: previewResult, duration, onOpenSession }:');
  change(message, '  const [expanded, setExpanded] = useState(() => isToolCallExpanded(block.toolCallId));', `  const [expanded, setExpanded] = useState(() => isToolCallExpanded(previewBlock.toolCallId));
  const callUrl = (previewBlock as ToolCallContent & { chatView?: { entryUrl?: string } }).chatView?.entryUrl;
  const resultUrl = (previewResult as (ToolResultMessage & { chatView?: { entryUrl?: string } }) | undefined)?.chatView?.entryUrl;
  const sourceKey = [callUrl, resultUrl].join("|");
  const [full, setFull] = useState<{ key: string; block: ToolCallContent; result?: ToolResultMessage } | null>(null);
  const [detailError, setDetailError] = useState("");
  const [retry, setRetry] = useState(0);
  const loaded = full?.key === sourceKey ? full : null;
  const block = loaded?.block ?? previewBlock;
  const result = loaded?.result ?? previewResult;
  useEffect(() => {
    if (!expanded || loaded || (!callUrl && !resultUrl)) return;
    const controller = new AbortController(); setDetailError("");
    const load = async (url: string | undefined) => {
      if (!url) return null;
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(\`HTTP \${response.status}\`);
      return (await response.json()).message as AgentMessage | null;
    };
    void Promise.all([load(callUrl), load(resultUrl)]).then(([call, paired]) => {
      if (controller.signal.aborted) return;
      const actual = call?.role === "assistant" ? call.content.find(b => b.type === "toolCall" && b.toolCallId === previewBlock.toolCallId) : previewBlock;
      if (!actual || actual.type !== "toolCall" || resultUrl && paired?.role !== "toolResult") throw new Error("工具原文不完整");
      setFull({ key: sourceKey, block: actual, result: paired?.role === "toolResult" ? paired : previewResult });
    }).catch(error => { if (!controller.signal.aborted) setDetailError(String(error)); });
    return () => controller.abort();
  }, [expanded, callUrl, resultUrl, sourceKey, loaded, previewBlock, previewResult, retry]);`);
  change(message, '      {/* ── Expanded: input args (only when no richer view exists) ── */}', `      {expanded && (callUrl || resultUrl) && !loaded && <div role={detailError ? "alert" : "status"} style={{ padding: "8px 10px" }}>
        {detailError ? <button type="button" onClick={() => setRetry(v => v + 1)}>加载失败，重试</button> : "正在加载工具原文…"}
      </div>}
      {/* ── Expanded: input args (only when no richer view exists) ── */}`);
  const manifest = JSON.parse(template('history/manifest.json'));
  for (const [name, expected] of Object.entries(manifest.files)) {
    const actual = createHash('sha256').update(get(name)).digest('hex');
    if (actual !== expected) throw new Error(`${name}: history output drift; re-merge and re-pin before integrating; zero writes`);
  }
}
