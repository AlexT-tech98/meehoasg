const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const html=fs.readFileSync('html','utf8');
test('ready order shipping change is rejected before upload or save',()=>{
 const section=html.slice(html.indexOf('function saveOrder('),html.indexOf('async function submitSettlement('));
 const guard=section.indexOf("['Chờ lấy','Chờ giao'].includes(oldOrder.status)");
 assert.ok(guard>=0,'ready status guard required');
 assert.ok(section.includes("String(oldOrder.shipping||'')==='Ghé lấy'"));
 assert.ok(section.includes("String(order.shipping||'')==='Ghé lấy'"));
 assert.ok(section.includes('Vui lòng chuyển về Chờ bó'));
 assert.ok(guard<section.indexOf("stage='files'"),'guard must run before image upload');
 assert.ok(guard<section.indexOf("stage='request'"),'guard must run before save request');
});
