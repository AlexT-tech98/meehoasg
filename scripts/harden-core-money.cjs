const fs=require('node:fs');
const path=require('node:path');
const file=path.join(__dirname,'..','supabase','functions','meehoasg-api-core','index.js');
let s=fs.readFileSync(file,'utf8');
const old="function num(v){const n=Number(String(v??0).replace(/[^\\d.-]/g,''));return Number.isFinite(n)?n:0}";
const next="function num(v){if(typeof v==='number')return Number.isFinite(v)?v:0;let raw=String(v??'0').replace(/[^\\d.,-]/g,'');if(raw.includes(',')&&raw.includes('.'))raw=raw.replaceAll('.','').replace(',','.');else if(/^-?\\d{1,3}(?:[.,]\\d{3})+$/.test(raw))raw=raw.replace(/[.,]/g,'');else raw=raw.replace(',','.');const n=Number(raw);return Number.isFinite(n)?n:0}";
if(s.includes(next)){console.log('Core money parser already hardened.');process.exit(0)}
if(!s.includes(old))throw new Error('Core num() anchor not found; inspect before changing money parsing.');
s=s.replace(old,next);
fs.writeFileSync(file,s);
console.log('Hardened core money parser for Vietnamese formatted amounts.');
