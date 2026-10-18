const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const nav=fs.readFileSync('assets/meehoa-v3.js','utf8');
const navCss=fs.readFileSync('assets/meehoa-v3.css','utf8');
const theme=fs.readFileSync('assets/meehoa-v365.css','utf8');
const dashboard=fs.readFileSync('assets/meehoa-v361.js','utf8');

test('global search is exposed consistently on Orders and Dashboard',()=>{
 assert.match(nav,/page==='orders'\|\|page==='dashboard'/);
 assert.match(navCss,/body\.mee-search-page \.topbar-search\{display:flex!important/);
});
test('both desktop and mobile show the full approved dashboard',()=>{
 assert.match(dashboard,/renderMetrics\(r\)/); assert.match(dashboard,/salesReport\(r\)/); assert.match(dashboard,/orderRows\(r\)/);
 assert.match(dashboard,/renderHourly\(r\)/);
 assert.doesNotMatch(dashboard,/mee-approved-attention/);
 assert.doesNotMatch(fs.readFileSync('html','utf8'),/Không có đơn cần xử lý gấp hôm nay/);
 assert.match(fs.readFileSync('assets/meehoa-v361.css','utf8'),/@media\(max-width:760px\)/);
});
