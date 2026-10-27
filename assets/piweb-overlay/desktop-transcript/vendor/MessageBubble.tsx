// Desktop's SmoothMessageBubble without its opt-in Electron plugin cards.
import { memo } from "react";
import { useSmoothText } from "./useSmoothText";
import { Markdown, MessageContext } from "./host";
import type { UiMessage } from "./model";
export const MessageBubble=memo(function MessageBubble({message,target}:{message:UiMessage;target?:boolean}){
  const streaming=message.status==="streaming";
  const reduced=typeof window!=="undefined"&&window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const content=useSmoothText(message.content,streaming,!reduced);
  return <div className={`message-bubble assistant-turn-fragment${streaming?" streaming":""}${streaming&&!reduced&&content?" smooth-cursor":""}`} data-entry-id={message.entryId} data-message-id={message.id} data-message-text data-search-target={target||undefined}><MessageContext.Provider value={message}><div className="prose-chat"><Markdown source={content} streaming={streaming}/></div></MessageContext.Provider></div>;
});
