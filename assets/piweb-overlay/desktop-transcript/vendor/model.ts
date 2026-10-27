// Pi Web -> Desktop UI contract. No host IPC, credentials or session writes.
import type { AssistantContentBlock, ToolCallContent, ToolResultMessage } from "@/lib/types";
import { getToolAction } from "./tool-display";
export type UiMessage = {
  id: string; role: string; content: string; thinking?: string; createdAt: string;
  status?: "streaming" | "completed" | "aborted" | "error";
  toolName?: string; toolArgs?: unknown; toolResult?: unknown; toolStatus?: string;
  toolCallId?: string; toolDurationMs?: number; toolCompletedAt?: string; responseDurationMs?: number;
  error?: {message:string};
  sourceBlock?: AssistantContentBlock; sourceResult?: ToolResultMessage;
  entryId?: string; blockIndex?: number;
};
export type SubagentOutcome = "running" | "completed" | "failed" | "denied" | "aborted" | "truncated" | "timed_out";
export type AssistantActivityItem =
  | {kind:"thinking";message:UiMessage}
  | {kind:"tool";message:UiMessage;delegate?:{items:AssistantActivityItem[]}}
  | {kind:"hostedSearch";message:UiMessage;round:{status:string;id:string}};
export type AssistantTurnPart = {kind:"message";message:UiMessage} | {kind:"activity";items:AssistantActivityItem[];endedAt?:string};
export type AssistantTurnEntry = {kind:"assistant-turn";id:string;parts:AssistantTurnPart[]};
export type TranscriptDisplayMode = "fully-folded" | "command-first" | "flat";
export type AgentActivity = {phase:"compacting"|"recovering"|"retrying"|"waiting-subagents"|"starting"|"waiting-model"|"preparing"};
export const isStandaloneRunActivity = (item:AssistantActivityItem):item is Extract<AssistantActivityItem,{kind:"tool"}> => item.kind === "tool" && getToolAction(item.message.toolName) === "run";
// Pi Web has no Desktop workspace review snapshot. Its existing edit result remains authoritative.
export const reviewChangeFromMessage = (_message:UiMessage) => null;
export function adaptTool(block:ToolCallContent,result:ToolResultMessage|undefined,at:number|undefined,live:boolean):UiMessage {
  const text=result?.content.filter((b):b is {type:"text";text:string}=>b.type==="text").map(b=>b.text).join("\n") ?? "";
  const action=getToolAction(block.toolName);
  let details:unknown=result?.details;
  // Desktop Bash/Read use structured payloads; Pi's tools often only provide text.
  if(action==="run" && result && !(details && typeof details==="object" && ("stdout" in details || "output" in details))) details={...(details&&typeof details==="object"?details:{}),stdout:text};
  else if(action==="read" && result && !(details && typeof details==="object" && "content" in details)) details={...(details&&typeof details==="object"?details:{}),content:text,path:block.input?.path};
  const completed=result?.timestamp;
  return {id:block.toolCallId,role:"tool",toolCallId:block.toolCallId,toolName:block.toolName,toolArgs:block.input,
    content:text,toolResult:result?{content:result.content,...(details?{details}:{})}:undefined,
    toolStatus:result?(result.isError?"error":"success"):live?"running":"unknown",status:!result&&live?"streaming":"completed",
    createdAt:at?new Date(at).toISOString():"",toolCompletedAt:completed?new Date(completed).toISOString():undefined,
    toolDurationMs:completed&&at?Math.max(0,completed-at):undefined,sourceBlock:block,sourceResult:result};
}
