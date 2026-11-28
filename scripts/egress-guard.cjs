'use strict';
// Pure billing guard. Inputs MUST come from verified Supabase billing usage, never logs.
const THRESHOLDS=[2,3,4];
function evaluate(snapshot, previous=null, alerted=[], nowMs=Date.now()){
  const alerts=[];
  const valid=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0;
  const fields=['uncachedGB','cachedGB','cycleStart','cycleEnd','observedAt','source','scope'];
  if(!snapshot||fields.some(k=>snapshot[k]===undefined||snapshot[k]===null)||!valid(snapshot.uncachedGB)||!valid(snapshot.cachedGB)||snapshot.source!=='supabase-billing-verified'||snapshot.scope!=='organization'||!snapshot.scopeId){
    return {status:'UNKNOWN',alerts:['Không thể xác nhận an toàn: thiếu dữ liệu Supabase Billing đáng tin cậy.']};
  }
  const start=Date.parse(snapshot.cycleStart),end=Date.parse(snapshot.cycleEnd),now=Date.parse(snapshot.observedAt);
  if(!Number.isFinite(start)||!Number.isFinite(end)||!Number.isFinite(now)||end<=start||now<start||now>end||nowMs-now>36*3600000||now>nowMs+300000){
    return {status:'UNKNOWN',alerts:['Không thể xác nhận an toàn: dữ liệu billing không hợp lệ hoặc đã cũ.']};
  }
  // Free has two independent 5 GB quotas, never a combined 5 GB quota.
  const total=snapshot.uncachedGB+snapshot.cachedGB;
  const uncached=snapshot.uncachedGB,cached=snapshot.cachedGB;
  const prior=previous&&previous.cycleStart===snapshot.cycleStart&&previous.scope===snapshot.scope&&previous.scopeId===snapshot.scopeId?previous:null;
  for(const [kind,value] of [['uncached',uncached],['cached',cached]])for(const t of THRESHOLDS){const key=snapshot.scopeId+':'+snapshot.cycleStart+':'+kind+':'+t;if(value>=t&&(!prior||prior[kind+'GB']<t)&&!alerted.includes(key))alerts.push('Egress '+kind+' đã vượt mốc '+t+' GB trong chu kỳ.');}
  const elapsedDays=Math.max((now-start)/86400000,1/24);
  const days=(end-start)/86400000,projectedUncachedGB=uncached/elapsedDays*days,projectedCachedGB=cached/elapsedDays*days;
  const projected=projectedUncachedGB+projectedCachedGB;
  if(projectedUncachedGB>5||projectedCachedGB>5)alerts.push('Cảnh báo: tốc độ hiện tại dự báo vượt 5 GB/chu kỳ ở ít nhất một loại Egress.');
  if(uncached>5||cached>5)alerts.push('Vượt giới hạn Free: ít nhất một loại Egress đã vượt 5 GB.');
  if(prior){
    const delta=total-prior.uncachedGB-prior.cachedGB,days=(now-Date.parse(prior.observedAt))/86400000;
    if(days>0&&delta>0.5&&delta/days>Math.max(1,2*total/elapsedDays))alerts.push('Cảnh báo: phát hiện tăng Egress bất thường.');
  }
  return {status:alerts.length?'ALERT':'OK',totalGB:total,uncachedGB:snapshot.uncachedGB,cachedGB:snapshot.cachedGB,projectedGB:projected,projectedUncachedGB,projectedCachedGB,alerts};
}
module.exports={evaluate};
