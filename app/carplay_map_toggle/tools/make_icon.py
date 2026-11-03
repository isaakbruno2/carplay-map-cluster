# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Isaak
#
# 140x140 tile icon: a white "M" (map) on a blue rounded tile.
# Supersampled 4x then downscaled for smooth edges. Needs Pillow.
#
#   python tools/make_icon.py <out.png>
import sys
from PIL import Image, ImageDraw

out = sys.argv[1] if len(sys.argv) > 1 else "carplay_map_toggle_icon.png"
S = 4
N = 140 * S
pad = 8 * S
radius = 28 * S
blue = (12, 99, 240, 255)
white = (235, 238, 242, 255)

img = Image.new("RGBA", (N, N), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# Blue rounded tile.
d.rounded_rectangle([pad, pad, N - pad, N - pad], radius=radius, fill=blue)

# White "M" as a thick polyline with rounded joints.
top = 48 * S
bottom = 94 * S
valley = 80 * S
lx = 42 * S
rx = 98 * S
mx = 70 * S
w = 11 * S
d.line([(lx, bottom), (lx, top), (mx, valley), (rx, top), (rx, bottom)],
       fill=white, width=w, joint="curve")
# Round the stroke ends (line joint="curve" leaves square caps).
for (x, y) in [(lx, bottom), (lx, top), (rx, top), (rx, bottom)]:
    d.ellipse([x - w // 2, y - w // 2, x + w // 2, y + w // 2], fill=white)

img = img.resize((140, 140), Image.LANCZOS)
img.save(out)
print("wrote", out, img.size)
