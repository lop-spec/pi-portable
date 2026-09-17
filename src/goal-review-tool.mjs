// Loaded explicitly ONLY by the authorized read-only review CLI, never as a resident extension.
import {inspect,tool} from './goal-inspect.mjs';
export default function(pi){
  pi.registerTool({name:tool.name,label:'Inspect source goal',description:tool.description,parameters:tool.inputSchema,
    async execute(_id,args){try{return {content:[{type:'text',text:JSON.stringify(await inspect(args))}]}}catch(e){console.error('goal-inspect failed:',e.message);throw e}}
  });
}
