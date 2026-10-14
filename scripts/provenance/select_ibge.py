"""Seleciona as medidas caseiras mais comuns da Tabela de Medidas Referidas (IBGE, POF 2008-2009).

Uso: python -I select_ibge.py liv50000.pdf ibge_all.csv ../../seeds/portions_ibge.csv
- ibge_all.csv vem de extract_ibge.py (extração geométrica por coordenadas).
- Cada linha selecionada só entra se a linha reconstruída aparecer literalmente no texto
  bruto da página (pdfium). Se a extração geométrica divergir, a linha é relida do texto
  bruto. Linha não conferida não entra.
"""
import csv
import re
import sys

import pypdfium2 as pdfium

pdf_path, all_csv, out_csv = sys.argv[1:4]

# (código IBGE, código do preparo, código da medida) — seleção manual das medidas mais comuns
SEL = [
    ('6300101', '99', '16 '), ('6300101', '99', '12 '), ('6300101', '99', '28 '), ('6300101', '99', '92 '),
    ('6300201', '99', '16 '), ('6300201', '99', '12 '),
    ('6303102', '99', '17 '), ('6303102', '99', '16 '), ('6303102', '99', '12 '),
    ('7109101', '3 ', '5 '), ('7109101', '2 ', '81 '), ('7109101', '4 ', '32 '),
    ('7104301', '99', '16 '), ('7104301', '99', '12 '),
    ('7800302', '4 ', '25 '), ('7800302', '4 ', '99 '), ('7800302', '4 ', '83 '), ('7800302', '4 ', '1 '),
    ('7800302', '2 ', '16 '),
    ('7800402', '3 ', '33 '), ('7800402', '6 ', '33 '),
    ('7600101', '3 ', '33 '), ('7600101', '2 ', '89 '),
    ('7803301', '2 ', '103 '), ('7803301', '5 ', '103 '), ('7803301', '5 ', '16 '), ('7803501', '2 ', '103 '),
    ('8000105', '99', '103 '), ('8000501', '99', '32 '), ('8001401', '99', '32 '), ('8000801', '99', '103 '),
    ('6501516', '99', '103 '), ('6902901', '99', '81 '), ('8502201', '99', '16 '), ('6501401', '99', '16 '),
    ('6503401', '2 ', '28 '), ('6503401', '2 ', '82 '), ('6503401', '2 ', '35 '),
    ('6400101', '2 ', '103 '), ('6400101', '2 ', '16 '), ('6400101', '5 ', '28 '),
    ('6400401', '2 ', '103 '), ('6400401', '2 ', '32 '), ('6400401', '2 ', '16 '), ('6400609', '2 ', '81 '),
    ('6801101', '99', '103 '), ('6801801', '99', '103 '), ('6803001', '99', '103 '),
    ('6803101', '99', '103 '), ('6803101', '99', '32 '),
    ('6802701', '99', '16 '), ('6803901', '99', '2 '), ('6805201', '99', '103 '),
    ('6700101', '99', '34 '), ('6705101', '99', '103 '), ('6705101', '99', '32 '), ('6401201', '99', '103 '),
    ('6701704', '2 ', '16 '),
    ('6500401', '99', '16 '), ('6504101', '99', '16 '), ('6906602', '99', '14 '), ('6906602', '99', '16 '),
    ('6901602', '99', '16 '),
    ('7900101', '99', '18 '), ('7903601', '99', '106 '), ('8501302', '99', '105 '), ('8500407', '99', '18 '),
    ('7901501', '99', '86 '), ('7901501', '99', '14 '), ('7901602', '99', '14 '),
    ('7902901', '99', '16 '), ('7902901', '99', '86 '),
    ('7901801', '99', '32 '), ('7901701', '99', '32 '), ('7902001', '99', '32 '), ('7902403', '99', '16 '),
    ('8102901', '99', '32 '), ('7801801', '99', '32 '), ('8400301', '99', '16 '), ('8400301', '99', '14 '),
    ('8102101', '99', '103 '), ('8102204', '2 ', '67 '), ('7703002', '99', '103 '), ('6900821', '99', '16 '),
]

rows = list(csv.DictReader(open(all_csv, encoding='utf-8')))
doc = pdfium.PdfDocument(pdf_path)
_cache = {}


def norm(s):
    return re.sub(r'\s+', ' ', s.replace('￾', '').replace('\x02', '')).strip()


def page_text(p):
    if p not in _cache:
        _cache[p] = norm(doc[p - 1].get_textpage().get_text_range())
    return _cache[p]


def from_geometry(code, prep, meas):
    hit = [r for r in rows if r['code'] == code and r['prep'].startswith(prep) and r['measure'].startswith(meas)]
    if len(hit) != 1:
        return None
    r = hit[0]
    grams = r['grams'].replace('.', ',')
    recon = norm(f"{r['code']} {r['food']} {r['prep']} {r['measure']} {r['std_measure']} {grams} "
                 f"{r['ref_source']} {r['ref_desc']}")
    return dict(r, page=int(r['page'])) if recon in page_text(int(r['page'])) else None


def from_raw_text(code, prep, meas):
    food = next(r['food'] for r in rows if r['code'] == code)
    for p in sorted({int(r['page']) for r in rows if r['code'] == code}):
        pat = (re.escape(f'{code} {food} ') + '(' + re.escape(prep.strip()) + r' [^\d]+?) '
               + '(' + re.escape(meas.strip()) + r' [^\d]+?) (\d+ [^\d]+?) (\d+(?:,\d+)?) (\d+) (.+?)(?= \d{7} |$)')
        m = re.search(pat, page_text(p))
        if m:
            return {'code': code, 'food': food, 'prep': m.group(1), 'measure': m.group(2),
                    'std_measure': m.group(3), 'grams': m.group(4).replace(',', '.'),
                    'ref_source': m.group(5), 'ref_desc': m.group(6), 'page': p}
    return None


out, errors = [], []
for code, prep, meas in SEL:
    r = from_geometry(code, prep, meas) or from_raw_text(code, prep, meas)
    if not r:
        errors.append(f'{code} {prep} {meas}: not verified')
        continue
    out.append({'codigo_ibge': r['code'], 'alimento': r['food'], 'preparo': re.sub(r'^\d+ ', '', r['prep']),
                'medida': re.sub(r'^\d+ ', '', r['measure']), 'gramas': r['grams'],
                'referencia': r['ref_desc'], 'fonte_ref': r['ref_source'], 'fonte_pagina': r['page']})

with open(out_csv, 'w', newline='', encoding='utf-8') as f:
    w = csv.DictWriter(f, fieldnames=list(out[0].keys()), lineterminator='\n')
    w.writeheader()
    w.writerows(out)
print('selected', len(SEL), 'written', len(out), 'errors', len(errors))
for e in errors:
    print(' ', e)
