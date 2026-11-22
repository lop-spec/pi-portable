import { setTimeout as delay } from 'node:timers/promises';
import { GOAL_ORIGIN } from './goal-transport.mjs';

// Optional read-only check against the actual local board, on an isolated profile.
export async function smokeDesktopGoal(contents) {
  let opened = false;
  for (let n = 0; n < 100 && !opened; n++) {
    opened = await contents.executeJavaScript("(()=>{const b=document.querySelector('.pw-goal-board-btn');if(!b)return false;b.click();return true})()");
    if (!opened) await delay(100);
  }
  if (!opened) throw new Error('desktop goal smoke: button missing');
  for (let n = 0; n < 100; n++) {
    const frame = contents.mainFrame.frames.find(item => item.url.startsWith(`${GOAL_ORIGIN}/`));
    if (frame) {
      try {
        const result = await frame.executeJavaScript(`(async()=>{
          const [overview,session]=await Promise.all([fetch('/api/overview'),fetch('/api/session')]);
          const d=await overview.json(),s=await session.json();
          return {status:overview.status,version:d.version,count:d.goals?.length,writable:s.writable,
            rendered:!!document.querySelector('#main') && !document.querySelector('#main .loading')};
        })()`);
        if (result.status === 200 && Number.isInteger(result.count) && result.rendered) return result;
      } catch { /* frame or board is still loading */ }
    }
    await delay(100);
  }
  throw new Error('desktop goal smoke: board did not load');
}
