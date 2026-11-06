// Final presentation stage: label the actual model above each process block.
export function integrateTurnModel({change,set,template}) {
  set('lib/turn-model-label.mjs',template('turn-model-label.mjs'));
  const timeline='components/PortableProcessTimeline.tsx';
  change(timeline,"import { projectCraftTurn } from '@/lib/craft-transcript-model.mjs';","import { projectCraftTurn } from '@/lib/craft-transcript-model.mjs';\nimport { resolveTimelineModel } from '@/lib/turn-model-label.mjs';");
  change(timeline,'streamingMessage?:AssistantMessage|null;onOpenFile?','streamingMessage?:AssistantMessage|null;activeModel?:{provider:string;modelId:string}|null;onOpenFile?');
  change(timeline,'  const projection=useMemo(()=>projectCraftTurn(entries,toolResults,live,end),[entries,toolResults,live,end]);','  const model=resolveTimelineModel(props);\n  const projection=useMemo(()=>projectCraftTurn(entries,toolResults,live,end),[entries,toolResults,live,end]);');
  change(timeline,'    {activities.length>0&&<div className="craft-work-log">','    {model&&<div className="craft-model-label" title={model.key+(model.reasoning?" / "+model.reasoning:"")} data-model={model.key} data-thinking={model.reasoning} aria-live={live?"polite":undefined}>{model.name}</div>}\n    {activities.length>0&&<div className="craft-work-log">');
  change('app/craft-transcript.css','.craft-work-log{min-width:0;', '.craft-model-label{max-width:100%;margin-bottom:2px;color:var(--text-muted);font-size:12px;line-height:20px;overflow-wrap:anywhere}\n.craft-work-log{min-width:0;');
  // Keep provider-verified display identity separate from the requested session model.
  change('lib/types.ts','export interface AssistantMessage {','export interface RuntimeModel { provider: string; modelId: string; reasoning: string; slug?: string }\n\nexport interface AssistantMessage {\n  runtimeModel?: RuntimeModel;');
  change('lib/ui-message.mjs',"['api', 'stopReason', 'rawStopReason', 'errorMessage', 'timestamp', 'usage']","['api', 'stopReason', 'rawStopReason', 'errorMessage', 'timestamp', 'usage', 'runtimeModel']");
  const wire='lib/agent-event-wire.ts';
  change(wire,'    const assistantMessageEvent = event.assistantMessageEvent;','    const assistantMessageEvent = event.assistantMessageEvent;\n    const runtimeModel = isObject(event.message) ? event.message.runtimeModel : undefined;');
  change(wire,'        assistantMessageEvent,\n      } as ClientMessageUpdateEvent;','        assistantMessageEvent: runtimeModel ? { ...assistantMessageEvent, runtimeModel } : assistantMessageEvent,\n      } as ClientMessageUpdateEvent;');
  change(wire,'      assistantMessageEvent: metadata ? { ...deltaEvent, ...metadata } : deltaEvent,','      assistantMessageEvent: { ...deltaEvent, ...(metadata ?? {}), ...(runtimeModel ? { runtimeModel } : {}) },');
  change('lib/streaming-message.ts','    case "delta":\n      return applyDelta(state, action.event);','    case "delta": {\n      const actual = (action.event as { runtimeModel?: AssistantMessage["runtimeModel"] }).runtimeModel;\n      const next = actual && state.streamingMessage ? { ...state, streamingMessage: { ...state.streamingMessage, runtimeModel: actual } } : state;\n      return applyDelta(next, action.event);\n    }');
  const chat='components/ChatWindow.tsx', hook='hooks/useAgentSession.ts';
  change(hook,'  const currentModel = currentModelOverride ?? liveModel ?? data?.context.model ?? pendingModel ?? null;','  const runtimeModel = liveModel ?? data?.context.model ?? null;\n  const currentModel = currentModelOverride ?? liveModel ?? data?.context.model ?? pendingModel ?? null;');
  change(hook,'isCompacting, compactError, compactResult, currentModel, displayModel, modelSwitching, sessionStats, autoCompactionEnabled,','isCompacting, compactError, compactResult, currentModel, displayModel, runtimeModel, modelSwitching, sessionStats, autoCompactionEnabled,');
  change(chat,'  livePhase?: string | null;\n}','  livePhase?: string | null;\n  activeModel?: { provider: string; modelId: string } | null;\n}');
  change(chat,'streamingReply, livePhase }: TurnViewProps)','streamingReply, livePhase, activeModel }: TurnViewProps)');
  change(chat,'            streamingMessage={options.live ? streamingReply : null}','            streamingMessage={options.live ? streamingReply : null}\n            activeModel={options.live ? activeModel : null}');
  change(chat,'[turn, ctx, searchEntryId, searchBlock, streamingReply, livePhase]);','[turn, ctx, searchEntryId, searchBlock, streamingReply, livePhase, activeModel]);');
  change(chat,'isCompacting, compactError, compactResult, displayModel: displayModelValue, modelSwitching, sessionStats,','isCompacting, compactError, compactResult, displayModel: displayModelValue, runtimeModel, modelSwitching, sessionStats,');
  change(chat,'                livePhase={turn.live ? livePhase : undefined}','                livePhase={turn.live ? livePhase : undefined}\n                activeModel={turn.live ? runtimeModel : undefined}');
}
