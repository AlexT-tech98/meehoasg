"""Offline CSV/JSONL activity_log export to retryable D1 SQL chunks.
No network access; private exports and generated SQL must never be committed.
"""
import argparse, csv, hashlib, json, pathlib
COLUMNS={'id','occurred_at','username','display_name','role','order_id','action','before_data','after_data'}

def quote(value): return "'"+value.replace("'","''")+"'"
def read_rows(path):
    if path.suffix.lower()=='.csv':
        csv.field_size_limit(20_000_000)
        with path.open(newline='',encoding='utf-8-sig') as f: yield from csv.DictReader(f)
    else:
        with path.open(encoding='utf-8') as f:
            for line in f:
                if line.strip(): yield json.loads(line)
def normalize(row):
    if not isinstance(row,dict) or not row.get('id'): raise ValueError('missing source id')
    if not set(row).issubset(COLUMNS): raise ValueError('unexpected columns')
    out={}
    for key in COLUMNS:
        if key not in row: continue
        val=row[key]
        if val in ('NULL','null') and key!='action': val=None
        if key in ('before_data','after_data') and isinstance(val,str) and val and val[0] in '{["':
            try: val=json.loads(val)
            except json.JSONDecodeError: pass
        if key=='id': val=int(val)
        out[key]=val
    return out

def statements(row):
    key=quote(str(row['id']))
    # Each statement must leave the CHECK(json_valid(data)) constraint true.
    # Append large fields as JSON strings, then restore objects/arrays.
    result=[f"INSERT INTO activity_log(row_key,data) VALUES({key},'{{}}') ON CONFLICT(row_key) DO UPDATE SET data='{{}}';"]
    for field,value in row.items():
        path=quote('$.'+field)
        encoded=json.dumps(value,ensure_ascii=False,separators=(',',':'))
        if len(encoded.encode('utf-8'))<=16000:
            result.append(f'UPDATE activity_log SET data=json_set(data,{path},json({quote(encoded)})) WHERE row_key={key};')
            continue
        raw=encoded if isinstance(value,(dict,list)) else str(value)
        result.append(f"UPDATE activity_log SET data=json_set(data,{path},'') WHERE row_key={key};")
        current=''
        for ch in raw:
            if len((current+ch).encode('utf-8'))>12000:
                result.append(f'UPDATE activity_log SET data=json_set(data,{path},json_extract(data,{path})||{quote(current)}) WHERE row_key={key};')
                current=''
            current+=ch
        if current: result.append(f'UPDATE activity_log SET data=json_set(data,{path},json_extract(data,{path})||{quote(current)}) WHERE row_key={key};')
        if isinstance(value,(dict,list)):
            result.append(f'UPDATE activity_log SET data=json_set(data,{path},json(json_extract(data,{path}))) WHERE row_key={key};')
    return result

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('source',type=pathlib.Path)
    ap.add_argument('--output',type=pathlib.Path,default=pathlib.Path(__file__).parent/'generated')
    ap.add_argument('--expected-count',type=int)
    args=ap.parse_args()
    if not args.source.is_file(): ap.error('Source missing')
    ids=set(); rows=[]
    for index,original in enumerate(read_rows(args.source),1):
        row=normalize(original);key=row['id']
        if key in ids: raise ValueError(f'Line {index}: duplicate id {key}')
        ids.add(key);rows.append(row)
    if args.expected_count is not None and len(rows)!=args.expected_count:raise ValueError(f'Expected {args.expected_count} rows, got {len(rows)}')
    args.output.mkdir(parents=True,exist_ok=True)
    for old in args.output.glob('activity-log-import-*.sql'):old.unlink()
    for i in range(0,len(rows),50):
        # D1's remote import rejects explicit BEGIN/COMMIT. Every row is
        # restartable, and final readback determines whether a batch succeeded.
        sql='\n'.join(s for row in rows[i:i+50] for s in statements(row))+'\n'
        (args.output/f'activity-log-import-{i//50:03d}.sql').write_text(sql,encoding='utf-8')
    manifest={'source_count':len(rows),'min_id':min(ids),'max_id':max(ids),'source_sha256':hashlib.sha256(args.source.read_bytes()).hexdigest(),'sql_chunks':(len(rows)+49)//50,'safe_to_rerun':True,'note':'Only staging; verify source contents and DB parity before cutover.'}
    (args.output/'activity-log-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    print(json.dumps(manifest,indent=2))
if __name__=='__main__':main()
