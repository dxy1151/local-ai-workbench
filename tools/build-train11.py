#!/usr/bin/env python3
# rp8c：新「详细但不冗长」素材(×3) + 旧多人素材(补格式连贯性) + 单角色锚
# 数据全部从冷目录（/mnt/data4t/训练数据（归档））读：API 生成的放 API生成/，成品写回 训练集/
import json, os, re, random
COLD='/mnt/data4t/训练数据（归档）'
L=COLD
NEW_MULTI=os.path.join(L,'API生成/style2/rows-style2-multi.jsonl')
NEW_SINGLE=os.path.join(L,'API生成/style2/rows-style2-single.jsonl')
OLD_MULTI=[os.path.join(L,'API生成/multi3',f) for f in ['rows-duo3.jsonl','rows-duo2.jsonl','rows-duo.jsonl','rows-duo4.jsonl','rows-long.jsonl','rows.jsonl']]
BASE=os.path.join(L,'训练集/gemma-train2.jsonl')
OUT=os.path.join(L,'训练集/gemma-train11.jsonl')
OLD_CAP=120; ANCHOR=100
TRAD=set('開還們這說來時過個沒為麼車東頭見長門問聽買賣錢幾給對後裏裡兒兩從會實當學覺讓無舊處號語話誰應該體發變樣點數隻雙邊關係願聲與嗎羅啟夢陳')

def load(p):
    out=[]
    if not os.path.exists(p): return out
    for line in open(p,encoding='utf-8'):
        line=line.strip()
        if not line: continue
        try: out.append(json.loads(line))
        except Exception: pass
    return out
def ismulti(r): return '多人扮演规则' in r['messages'][0]['content']
def norm(t):
    def rep(m):
        inner=m.group(1).strip(); return f'（{inner}）' if inner else m.group(0)
    o=re.sub(r'(?<!\*)\*([^*\n]{1,160})\*(?!\*)',rep,t)
    o=re.sub(r'([：:]\s*)我[：:]\s*',r'\1',o); o=re.sub(r'\*{2,}','',o)
    return o.strip()
def clean(r):
    msgs=[{'role':m['role'],'content':norm(str(m.get('content') or ''))} for m in r['messages']]
    if not msgs or msgs[0]['role']!='system': return None
    if len(msgs)<3 or msgs[-1]['role']!='assistant': return None
    if any(ch in TRAD for m in msgs if m['role']=='assistant' for ch in m['content']): return None
    return {'messages':msgs}
def rich(r):
    a=[m for m in r['messages'] if m['role']=='assistant']
    ok=sum(1 for m in a if len(re.findall(r'^[^\s：:]{1,12}[：:]', m['content'], re.M))>=2)
    return ok/max(1,len(a))>=0.8
def main():
    nm=[clean(r) for r in load(NEW_MULTI)]; ns=[clean(r) for r in load(NEW_SINGLE)]
    nm=[r for r in nm if r and ismulti(r)]; ns=[r for r in ns if r and not ismulti(r)]
    old=[]
    for p in OLD_MULTI:
        for r in load(p):
            c=clean(r)
            if c and ismulti(c) and rich(c): old.append(c)
    anchors=[clean(r) for r in load(BASE)]; anchors=[r for r in anchors if r and not ismulti(r)]
    rng=random.Random(20261101)
    if len(old)>OLD_CAP: old=rng.sample(old,OLD_CAP)
    if len(anchors)>ANCHOR: anchors=rng.sample(anchors,ANCHOR)
    rows=nm*3+ns*3+old+anchors
    seen=set(); out=[]
    for r in rows:
        k=(r['messages'][0]['content'][:80], (r['messages'][1]['content'] if len(r['messages'])>1 else '')[:80])
        if k in seen: continue
        seen.add(k); out.append(r)
    rng.shuffle(out)
    with open(OUT,'w',encoding='utf-8') as f:
        for r in out: f.write(json.dumps(r,ensure_ascii=False)+'\n')
    a=[m['content'] for r in out for m in r['messages'] if m['role']=='assistant']; lens=sorted(len(x) for x in a)
    print(f'新multi {len(nm)}x3 + 新single {len(ns)}x3 + 旧multi {len(old)} + 锚 {len(anchors)} → {len(out)} 行')
    print(f'assistant {len(a)} 条，中位 {lens[len(lens)//2]}')
if __name__=='__main__': main()
