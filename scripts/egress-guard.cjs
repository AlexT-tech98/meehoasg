'use strict';
// Pure billing guard. Inputs MUST come from verified Supabase billing usage, never logs.
const THRESHOLDS=[2,3,4];
function evaluate(snapshot, previous=null, alerted=[]){
  const alerts=[];
  const valid=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0;
  const fields=['uncachedGB','cachedGB','cycleStart','cycleEnd','observedAt','source','scope'];
  if(!snapshot||fields.some(k=>snapshot[k]===undefined||snapshot[k]===null)||!valid(snapshot.uncachedGB)||!valid(snapshot.cachedGB)||snapshot.source!=='supabase-billing-verified'||!['organization','project'].includes(snapshot.scope)){
    return {status:'UNKNOWN',alerts:['Không thể xác nhận an toàn: thiếu dữ liệu Supabase Billing đáng tin cậy.']};
  }
  const start=Date.parse(snapshot.cycleStart),end=Date.parse(snapshot.cycleEnd),now=Date.parse(snapshot.observedAt);
  if(!Number.isFinite(start)||!Number.isFinite(end)||!Number.isFinite(now)||end<=start||now<start||now>end||Date.now()-now>36*3600000||now>Date.now()+300000){
    return {status:'UNKNOWN',alerts:['Không thể xác nhận an toàn: dữ liệu billing không hợp lệ hoặc đã cũ.']};
  }
  const total=snapshot.uncachedGB+snapshot.cachedGB;
  const prior=previous&&previous.cycleStart===snapshot.cycleStart&&previous.scope===snapshot.scope&&previous.scopeId===snapshot.scopeId?previous:null;
  for(const t of THRESHOLDS)if(total>=t&&(!prior||prior.uncachedGB+prior.cachedGB<t)&&!alerted.includes(snapshot.cycleStart+':'+t))alerts.push('Egress đã vượt mốc '+t+' GB trong chu kỳ.');
  const elapsedDays=Math.max((now-start)/86400000,1/24);
  const projected=total/elapsedDays*((end-start)/86400000);
  if(projected>5)alerts.push('Cảnh báo: tốc độ hiện tại dự báo vượt 5 GB/chu kỳ.');
  if(prior){
    const delta=total-prior.uncachedGB-prior.cachedGB,days=(now-Date.parse(prior.observedAt))/86400000;
    if(days>0&&delta>0.5&&delta/days>Math.max(1,2*total/elapsedDays))alerts.push('Cảnh báo: phát hiện tăng Egress bất thường.');
  }
  return {status:alerts.length?'ALERT':'OK',totalGB:total,uncachedGB:snapshot.uncachedGB,cachedGB:snapshot.cachedGB,projectedGB:projected,alerts};
}
module.exports={evaluate};
