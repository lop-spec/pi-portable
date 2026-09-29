// Pure, conservative 48-hour reservation model. One unit = 1% of a Pro account.
export const POLICY = Object.freeze({daily:60, days:2, margin:1.1, taskBudget:10, horizonHours:48, referencePlan:'pro'});
const HOUR=3600000;
export function forecast(accounts, spend, now, policy=POLICY) {
  const end=now+policy.horizonHours*HOUR;
  const pool=accounts.map(a=>({...a,cards:[...a.cards],balance:a.remaining}));
  function take(amount, allowCards) {
    for(const a of pool.slice().sort((a,b)=>allowCards?a.resetAt-b.resetAt:b.resetAt-a.resetAt)) {const n=Math.min(a.balance,amount);a.balance-=n;amount-=n;}
    if(allowCards) for(const a of pool) while(amount>1e-8&&a.cards.length){
      a.cards.shift();a.balance=100;
      // A card may move the natural reset. Never count BOTH the card and the old reset.
      a.resetAt=Infinity;
      const n=Math.min(a.balance,amount);a.balance-=n;amount-=n;
    }
    return amount<=1e-8;
  }
  // Automated work must use current balance, never hypothetical cards or future refreshes.
  // Debit latest-reset balances first: conservative even if the existing sticky router
  // does not spend the expiring account. Human reserve uses earliest-reset-first.
  if(!take(spend,false))return false;
  // Keep an immediate 6% buffer, then cover every interval before each reset.
  if(!take(policy.daily*0.1,true))return false;
  const events=[...new Set(pool.map(a=>a.resetAt).filter(t=>t>now&&t<end)),end].sort((a,b)=>a-b);
  let at=now;
  for(const next of events){
    if(!take((next-at)/(24*HOUR)*policy.daily*policy.margin,true))return false;
    for(const a of pool)if(a.resetAt===next){a.balance=100;a.resetAt=Infinity;}
    at=next;
  }
  return true;
}
export function evaluateReserve(accounts,{now=Date.now(),reserved=0,policy=POLICY}={}) {
  const current=accounts.reduce((s,a)=>s+a.remaining,0);
  let low=0,high=current;
  const protectedEnough=forecast(accounts,0,now,policy);
  if(protectedEnough)for(let n=0;n<40;n++){const mid=(low+high)/2;if(forecast(accounts,mid,now,policy))low=mid;else high=mid;}
  const disposable=protectedEnough?low:0;
  let deficit=0;
  if(!protectedEnough){
    let lo=0,hi=policy.daily*policy.days*policy.margin+policy.daily*0.1;
    for(let n=0;n<40;n++){const mid=(lo+hi)/2;if(forecast([...accounts,{remaining:mid,resetAt:Infinity,cards:[]}],0,now,policy))hi=mid;else lo=mid;}
    deficit=hi;
  }
  const reserve=current-disposable+deficit;
  const allow=protectedEnough&&forecast(accounts,reserved+policy.taskBudget,now,policy);
  return {allow,reason:allow?'48h-reserve-protected':protectedEnough?'below-reserve-plus-task-budget':'insufficient-personal-48h-reserve',currentPercent:current,expectedMinimumPercent:Math.ceil((reserve+reserved+policy.taskBudget)*100)/100,personalReservePercent:Math.ceil(reserve*100)/100,reservedPercent:reserved,taskBudgetPercent:policy.taskBudget,dailyPercent:policy.daily,protectedHours:policy.horizonHours,marginPercent:Math.round((policy.margin-1)*100),usableAccounts:accounts.length,verifiedCards:accounts.reduce((s,a)=>s+a.cards.length,0)};
}
export function normalizeAccount({id,identityHash,usage,cards,autoReset=true},now=Date.now()) {
  if(usage?.plan_type!==POLICY.referencePlan)return {excluded:id,reason:'unknown-capacity-relative-to-pro'};
  const windows=[usage?.rate_limit?.primary_window,usage?.rate_limit?.secondary_window].filter(Boolean);
  if(windows.length>1)return {excluded:id,reason:'multi-window-capacity-not-comparable'};
  if(!windows.length||windows.some(w=>!Number.isFinite(w.used_percent)||w.used_percent<0||w.used_percent>100||!Number.isFinite(w.limit_window_seconds)||w.limit_window_seconds<=0))return {excluded:id,reason:'invalid-quota-windows'};
  const resets=windows.map(w=>Number(w.reset_at??w.resets_at)*1000);
  if(resets.some(t=>!Number.isFinite(t)||t<=now))return {excluded:id,reason:'expired-or-invalid-reset'};
  const end=now+POLICY.horizonHours*HOUR;
  const applicable=(autoReset&&Number.isSafeInteger(cards?.available_count)&&cards.available_count>0?cards.credits||[]:[]).filter(c=>typeof c.id==='string'&&c.status==='available'&&c.is_supported_by_plan===true&&Date.parse(c.expires_at)>end&&windows.every(w=>c.reset_type==='codex_rate_limits'||c.reset_type==='codex_weekly'&&w.limit_window_seconds===604800||c.reset_type==='codex_five_hour'&&w.limit_window_seconds===18000));
  return {id,identityHash,remaining:usage.rate_limit.allowed===false?0:Math.min(...windows.map(w=>100-w.used_percent)),resetAt:Math.max(...resets),cards:[...new Set(applicable.map(c=>c.id))].slice(0,cards?.available_count||0)};
}
