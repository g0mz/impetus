import csv, re, sys
import pypdfium2 as pdfium
src, out = sys.argv[1], sys.argv[2]
doc = pdfium.PdfDocument(src)
BANDS = {'food': (70, 262), 'prep': (262, 362), 'measure': (362, 448), 'std': (448, 526), 'qty': (526, 760)}
def clean(s): return re.sub(r'\s+', ' ', s.replace('\r\n', ' ').replace('\ufffe', '').replace('\x02', '')).strip()
rows = []
for pi in range(len(doc)):
    page = doc[pi]; tp = page.get_textpage()
    if '(g)' not in tp.get_text_range()[:3000]:
        continue
    starts = sorted({round(tp.get_rect(i)[0], 1) for i in range(tp.count_rects())
                     if tp.get_rect(i)[0] > 110 and 70 <= tp.get_rect(i)[1] <= 80
                     and re.match(r'^\d{7} ', tp.get_text_bounded(*tp.get_rect(i)))})
    w, h = page.get_size()
    for k, x0 in enumerate(starts):
        x1 = starts[k + 1] - 1 if k + 1 < len(starts) else w
        cell = {n: clean(tp.get_text_bounded(left=x0 - 1, bottom=lo, right=x1, top=hi)) for n, (lo, hi) in BANDS.items()}
        m = re.match(r'^(\d{7}) (.*)$', cell['food'])
        q = re.match(r'^(\d+(?:,\d+)?) (\d+) (.*)$', cell['qty'])
        if not m or not q:
            print('SKIP p', pi + 1, cell, file=sys.stderr); continue
        rows.append({'page': pi + 1, 'code': m.group(1), 'food': m.group(2), 'prep': cell['prep'],
                     'measure': cell['measure'], 'std_measure': cell['std'],
                     'grams': q.group(1).replace(',', '.'), 'ref_source': q.group(2), 'ref_desc': q.group(3)})
with open(out, 'w', newline='', encoding='utf-8') as f:
    wr = csv.DictWriter(f, fieldnames=list(rows[0].keys())); wr.writeheader(); wr.writerows(rows)
print('rows', len(rows), 'foods', len({r['code'] for r in rows}))
