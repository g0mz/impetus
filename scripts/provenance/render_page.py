import sys, pypdfium2 as pdfium
pdf = pdfium.PdfDocument(sys.argv[1]); page = pdf[int(sys.argv[2]) - 1]
img = page.render(scale=float(sys.argv[4])).to_pil()
if len(sys.argv) > 5:
    x0, y0, x1, y1 = map(float, sys.argv[5].split(','))
    w, h = img.size; img = img.crop((int(x0*w), int(y0*h), int(x1*w), int(y1*h)))
img.save(sys.argv[3])
