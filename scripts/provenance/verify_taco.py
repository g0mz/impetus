import csv, re, sys
txt, foodcsv, nutcsv = sys.argv[1:4]
lines = open(txt, encoding='utf-8').read().splitlines()
names = {int(r['id']): r['name'] for r in csv.DictReader(open(foodcsv, encoding='utf-8'))}
nut = {int(r['foodId']): r for r in csv.DictReader(open(nutcsv, encoding='utf-8'))}
tok = re.compile(r'^(?:\d+(?:,\d+)?|Tr|NA|\*)$')
cols = ['moisture','kcal','kJ','protein','lipids','cholesterol','carbohydrates','dietaryFiber','ash','calcium','magnesium']
full = {}
for l in lines:
    m = re.match(r'^(\d{1,3})\s+(.*)$', l)
    if not m: continue
    fid = int(m.group(1)); rest = m.group(2)
    if fid not in names or not rest.startswith(names[fid]): continue
    vals = rest[len(names[fid]):].split()
    if len(vals) == 11 and all(tok.match(v) for v in vals) and fid not in full:
        full[fid] = vals
print('csv foods:', len(names), 'ids 1..', max(names), '| full rows parsed from PDF:', len(full))
diffs = 0
for fid, vals in sorted(full.items()):
    for c, v in zip(cols, vals):
        cv = nut[fid][c]
        if v in ('NA', '*'):
            ok = cv == ''
        elif v == 'Tr':
            ok = cv in ('', '0', '0.0', '0.00') or float(cv) == 0
        else:
            ok = cv != '' and abs(float(v.replace(',', '.')) - float(cv)) < 1e-9
        if not ok:
            diffs += 1; print('DIFF', fid, names[fid], c, 'pdf=', v, 'csv=', repr(cv))
print('compared', len(full)*len(cols), 'values; diffs:', diffs)
for fid in (1, 3, 410, 561, 23):
    if fid in full: print(fid, names[fid], dict(zip(cols[:8], full[fid][:8])))
