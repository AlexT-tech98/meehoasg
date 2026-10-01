const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');
const entry=fs.readFileSync('index.html','utf8');const api=fs.readFileSync('supabase/functions/meehoasg-api-v364/index.js','utf8');const js=fs.readFileSync('assets/meehoa-v364.js','utf8');const css=fs.readFileSync('assets/meehoa-v364.css','utf8');
test('production routes through v364 and loads v364 assets',()=>{assert.match(entry,/meehoasg-api-v364/);assert.match(entry,/meehoa-v364\.css\?v=4\.6\.4/);assert.match(entry,/meehoa-v364\.js\?v=4\.6\.4/)});
test('dashboard is handled directly instead of the multi-proxy chain',()=>{assert.match(api,/name==='getDashboardSummary'/);assert.match(api,/r=await dash\(p\)/);assert.match(api,/SPLIT_SETTLEMENT/)});
test('materials has an explicit local fallback when Gemini key is absent',()=>{assert.match(api,/!GEMINI_KEY/);assert.match(api,/FALLBACK_NO_KEY/);assert.match(api,/v364-local-fallback/);assert.match(api,/Hồng Ecuador/);assert.match(api,/Ly xanh nhuộm/)});
test('payment check targets real settlement card DOM and select all',()=>{assert.match(js,/\.settlement-card/);assert.match(js,/\.settle-check/);assert.match(js,/Chọn tất cả/);assert.match(css,/mee-settlement-grid-v364/);assert.match(css,/height:150px!important/)});
test('paid production card copy is Bankful full hoa',()=>{assert.match(js,/Bankful full hoa/)});
