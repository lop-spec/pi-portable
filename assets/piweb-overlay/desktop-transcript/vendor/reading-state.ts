// Page-lifetime Desktop reading choices; never written to model/session storage.
export type TranscriptDisclosureChoice = {open:boolean;revealRequest?:number};
const sessions = new Map<string,{disclosures:Map<string,TranscriptDisclosureChoice>}>();
export function sessionReadingState(id:string) {
  let state=sessions.get(id);
  if(!state){state={disclosures:new Map()};sessions.set(id,state);}
  return state;
}
