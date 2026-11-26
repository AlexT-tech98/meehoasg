const TABLES=new Set(['orders','app_users','app_sessions','login_attempts','settlement_requests','kpi_operations','activity_log','flower_cache','performance_log','operation_receipts','sale_aliases','deleted_orders','sync_config','sync_runs','sync_cursors']);
const KEY={orders:'id',app_users:'username',app_sessions:'token_hash',login_attempts:'username',settlement_requests:'id',kpi_operations:'id',flower_cache:'fingerprint',activity_log:'id',deleted_orders:'id',sync_config:'id'};
function identifier(value){if(!/^[a-z][a-z0-9_]*$/.test(value))throw Error('Invalid column');return value;}
function rowKey(table,row){return KEY[table]&&row[KEY[table]]!=null?String(row[KEY[table]]):table+'-'+crypto.randomUUID();}
function decodeRows(results){return(results||[]).map(x=>({key:x.row_key,row:JSON.parse(x.data)}));}
function parseIn(value){return value.slice(4,-1).match(/"(?:\\.|[^"])*"|[^,]+/g)?.map(x=>x.trim().replace(/^"|"$/g,''))||[];}
function filters(query){const where=[],params=[];
  function add(col,expr){col=identifier(col);const path=`'$.${col}'`;let op,val;
    if(expr.startsWith('eq.')){op='=';val=expr.slice(3)}
    else if(expr.startsWith('gte.')){op='>=';val=expr.slice(4)}
    else if(expr.startsWith('lte.')){op='<=';val=expr.slice(4)}
    else if(expr.startsWith('in.(')){const values=parseIn(expr);if(!values.length){where.push('0');return}where.push(`json_extract(data,${path}) IN (${values.map(()=>'?').join(',')})`);params.push(...values);return}
    else throw Error('Unsupported filter '+col);
    where.push(`json_extract(data,${path}) ${op} ?`);params.push(val);
  }
  for(const [col,expr] of Object.entries(query||{})){
    if(['select','order','limit','offset','on_conflict'].includes(col))continue;
    if(col==='and'){
      const pairs=String(expr).replace(/^\(|\)$/g,'').split(/,(?=[a-z_]+\.)/);
      for(const pair of pairs){const m=pair.match(/^([a-z_]+)\.(eq|gte|lte)\.(.*)$/);if(!m)throw Error('Unsupported and filter');add(m[1],m[2]+'.'+m[3])}
    }else add(col,String(expr));
  }
  return {sql:where.length?' WHERE '+where.join(' AND '):'',params};
}
function orderBy(value){if(!value)return'';return ' ORDER BY '+String(value).split(',').map(part=>{const [col,dir]=part.split('.');return `json_extract(data,'$.${identifier(col)}') ${dir==='desc'?'DESC':'ASC'}`}).join(',');}
function selectRows(rows,select){if(!select||select==='*')return rows.map(x=>x.row);const columns=select.split(',').map(identifier);return rows.map(({row})=>Object.fromEntries(columns.map(c=>[c,row[c]??null])))}
export function createDb(binding,{rpc}={}){
  return async function db(table,query={},method='GET',body){
    if(table.startsWith('rpc/')){if(!rpc)throw Error('RPC unavailable');return rpc(table.slice(4),body)}
    if(!TABLES.has(table))throw Error('Unknown table '+table);
    const f=filters(query),limit=Math.min(1000,Math.max(1,Number(query.limit)||1000)),offset=Math.max(0,Number(query.offset)||0);
    if(method==='GET'){
      const result=await binding.prepare(`SELECT row_key,data FROM ${table}${f.sql}${orderBy(query.order)} LIMIT ? OFFSET ?`).bind(...f.params,limit,offset).all();
      return selectRows(decodeRows(result.results),query.select);
    }
    if(method==='POST'){
      const rows=Array.isArray(body)?body:[body],out=[];
      for(const row of rows){
        const key=rowKey(table,row);
        // PostgREST merge-duplicates updates supplied columns only. Preserve
        // existing JSON fields when an upsert provides a partial row.
        const statement=query.on_conflict
          ? `INSERT INTO ${table}(row_key,data) VALUES(?,?) ON CONFLICT(row_key) DO UPDATE SET data=json_patch(${table}.data,excluded.data)`
          : `INSERT INTO ${table}(row_key,data) VALUES(?,?)`;
        await binding.prepare(statement).bind(key,JSON.stringify(row)).run();out.push(row);
      }
      return out;
    }
    const result=await binding.prepare(`SELECT row_key,data FROM ${table}${f.sql}`).bind(...f.params).all();
    const matched=decodeRows(result.results),out=[];
    for(const {key,row} of matched){
      if(method==='PATCH'){
        const next={...row,...body};
        await binding.prepare(`UPDATE ${table} SET data=? WHERE row_key=?`).bind(JSON.stringify(next),key).run();out.push(next);
      }else if(method==='DELETE'){
        await binding.prepare(`DELETE FROM ${table} WHERE row_key=?`).bind(key).run();out.push(row);
      }else throw Error('Unsupported method '+method);
    }
    return out;
  };
}
