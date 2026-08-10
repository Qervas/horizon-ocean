"""Composites the contact-sheet cells into a single labelled image.

Usage: python scripts/composite-sheet.py [cols]

Kept separate from contact-sheet.mjs because Node has no image library
available here without adding a dependency, and this project has no build step.
"""
import json
import os
import sys

from PIL import Image, ImageDraw

COLS = int(sys.argv[1]) if len(sys.argv) > 1 else 3
PAD = 8
LABEL_H = 22
BG = (24, 26, 30)
FG = (210, 215, 222)

d = os.path.join("ref", "captures", "sheet")
manifest = json.load(open(os.path.join(d, "manifest.json")))
cells = manifest["cells"]

images = [Image.open(c["file"]) for c in cells]
w, h = images[0].size
rows = (len(images) + COLS - 1) // COLS

sheet = Image.new(
    "RGB",
    (COLS * w + (COLS + 1) * PAD, rows * (h + LABEL_H) + (rows + 1) * PAD),
    BG,
)
draw = ImageDraw.Draw(sheet)

for i, (im, cell) in enumerate(zip(images, cells)):
    row, col = divmod(i, COLS)
    x = PAD + col * (w + PAD)
    y = PAD + row * (h + LABEL_H + PAD)
    sheet.paste(im, (x, y + LABEL_H))
    draw.text((x + 4, y + 5), cell["label"], fill=FG)

out = os.path.join(d, "contact-sheet.png")
sheet.save(out)
print(f"{out} {sheet.size[0]}x{sheet.size[1]} ({len(images)} cells)")
