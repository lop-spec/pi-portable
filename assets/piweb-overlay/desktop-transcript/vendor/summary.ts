// Desktop activity-summary rules over the Pi Web adapter's direct tool rows.
import type { AssistantActivityItem, SubagentOutcome } from "./model";
import { getToolAction } from "./tool-display";
import { runOutcome } from "./tool-presentation";
export function cachedActivitySummary(items:readonly AssistantActivityItem[], _statuses?:ReadonlyMap<string,SubagentOutcome>) {
  let tools=0,thinking=0,issues=0,allRun=true,allSearch=true;
  for(const item of items){
    if(item.kind==="thinking"){thinking++;continue;}
    tools++;
    if(item.kind==="hostedSearch"){allRun=false;if(item.round.status==="failed")issues++;continue;}
    const action=getToolAction(item.message.toolName);
    allRun &&= action==="run"; allSearch &&= action==="search";
    if(item.message.toolStatus==="error"||item.message.toolStatus==="denied"||(action==="run"&&runOutcome(item.message)==="failed"))issues++;
  }
  return {label:tools===0?"chat.activityThinking":allRun?"chat.activityCommands":allSearch?"chat.activitySearches":"chat.activityTools",count:tools||thinking,tools,thinking,issues};
}
