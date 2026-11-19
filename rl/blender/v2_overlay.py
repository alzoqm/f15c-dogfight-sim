#!/usr/bin/env python3
# Round-1 overlay + sheet composer (system python, Pillow). Reads rl/blender/v2/ortho_*_raw.png + preview_*.png
import os, json, math, struct
from PIL import Image, ImageDraw, ImageFont

WS = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
V2 = os.path.join(WS, 'rl', 'blender', 'v2')
with open(os.path.join(V2, 'ortho_meta.json')) as f:
    META = json.load(f)
Cx, Cy, Cz = META['center']
SCALES = {k: v['scale'] for k, v in META['views'].items()}
W, H = 1600, 900
F = ImageFont.load_default()

def load_white(path):
    im = Image.open(path)
    if 'A' in im.getbands():
        bg = Image.new('RGB', im.size, (255, 255, 255))
        bg.paste(im, mask=im.split()[-1])
        return bg
    # fallback chroma-key from corners
    rgb = im.convert('RGB')
    px = rgb.load()
    import statistics
    samples = []
    for (x, y) in [(5, 5), (W-6, 5), (5, H-6), (W-6, H-6), (W//2, 5), (W//2, H-6)]:
        samples.append(px[x, y])
    br = sum(s[0] for s in samples)//len(samples); bgc = sum(s[1] for s in samples)//len(samples); bb = sum(s[2] for s in samples)//len(samples)
    out = Image.new('RGB', (W, H), (255, 255, 255))
    op = out.load()
    for y in range(H):
        for x in range(W):
            r, g, b = px[x, y]
            if abs(r-br)+abs(g-bgc)+abs(b-bb) < 60:
                continue
            op[x, y] = (r, g, b)
    return out

def S_top(x, y):
    s = W/SCALES['top']; return (800+(x-Cx)*s, 450-(y-Cy)*s)
def S_side(y, z):
    s = W/SCALES['side']; return (800-(y-Cy)*s, 450-(z-Cz)*s)  # cam on -X, nose left
def S_front(x, z):
    s = W/SCALES['front']; return (800-(x-Cx)*s, 450-(z-Cz)*s)  # mirrored, symmetric

def draw_poly(d, pts, fill=(255, 0, 0), width=3):
    d.line(pts, fill=fill, width=width, joint='curve')

def circle(d, c, r_world, proj, fill=(255, 0, 0), width=3):
    s = W/SCALES[proj.__name__.split('_')[-1] if False else {'S_top':'top','S_side':'side','S_front':'front'}[proj.__name__]]
    cx, cy = c
    r = r_world*s
    d.ellipse([cx-r, cy-r, cx+r, cy+r], outline=fill, width=width)

# ---------- TOP target (with 0.4m tip chamfer; tail narrowed round4) ----------
top_right = [(0,10.05),(0.35,8.85),(0.55,7.45),(0.60,6.45),(0.65,5.05),(0.78,4.45),
    (2.10,4.55),(2.15,2.05),(2.10,1.45),(6.25,-2.765),(6.53,-3.45),(6.53,-4.55),(2.10,-3.55),
    (1.50,-3.45),(1.40,-4.95),(1.70,-5.55),(4.123,-7.973),(4.30,-8.40),(4.30,-9.25),(1.70,-8.85),
    (1.225,-8.55),(1.225,-9.35),(0,-9.35)]
top_left = [(-x,y) for (x,y) in reversed(top_right)]
top_loop = top_right + top_left[1:] + [top_right[0]]

# ---------- SIDE target ----------
side_top = [(10.05,0.05),(8.85,0.38),(7.45,0.55),(6.65,0.62),(6.00,0.90),(5.85,1.10),(5.15,1.42),
    (4.25,1.25),(2.85,0.95),(2.05,0.76),(0.55,0.82),(-0.95,0.74),(-1.95,0.72),(-3.45,0.62),(-4.25,0.60),
    (-6.55,3.53),(-8.25,3.53),(-7.85,0.60),(-8.55,0.50),(-9.35,0.49)]
side_bot = [(-9.35,-0.55),(-8.55,-0.55),(-6.95,-0.62),(-3.45,-0.70),(-0.95,-0.78),
    (2.05,-0.80),(3.55,-0.80),(3.95,-0.75),(4.65,-0.60),(5.05,-0.62),(6.45,-0.58),
    (7.45,-0.50),(8.85,-0.30),(10.05,0.05)]
side_inlet_slant = [(4.65,0.55),(3.95,-0.75)]  # inlet face: top lip fwd, bottom lip aft

# ---------- FRONT target ----------
front_box = [(-2.15,-0.80),(-2.15,0.66),(2.15,0.66),(2.15,-0.80),(-2.15,-0.80)]
front_canopy = [(-0.475,0.62),(-0.475,1.00),(0,1.42),(0.475,1.00),(0.475,0.62)]
front_spine = [(-0.38,0.66),(0,0.80),(0.38,0.66)]

jobs = []
# top
im = load_white(os.path.join(V2, 'ortho_top_raw.png'))
d = ImageDraw.Draw(im)
draw_poly(d, [S_top(x, y) for (x, y) in top_loop])
d.text((16, 14), 'TOP  red=spec target  gray=render  scale=38', font=F, fill=(0, 0, 0))
d.text((16, 30), 'nose up. wing LE 45deg / span +-6.53 / intake outer +-2.10', font=F, fill=(0, 0, 0))
im.save(os.path.join(V2, 'overlay_top.png'))
jobs.append('overlay_top.png')
# side
im = load_white(os.path.join(V2, 'ortho_side_raw.png'))
d = ImageDraw.Draw(im)
draw_poly(d, [S_side(y, z) for (y, z) in side_top])
draw_poly(d, [S_side(y, z) for (y, z) in side_bot])
draw_poly(d, [S_side(y, z) for (y, z) in side_inlet_slant])
for (gy, ztop, r) in [(6.75, -0.62, 0.28), (-1.15, -0.70, 0.425)]:
    s = W/SCALES['side']
    cx, cy = S_side(gy, ztop-r)
    rr = r*s
    d.ellipse([cx-rr*0.25, cy-rr, cx+rr*0.25, cy+rr], outline=(255, 0, 0), width=3)  # edge-on wheel
    d.line([S_side(gy, ztop), S_side(gy, ztop-r)], fill=(255, 0, 0), width=3)
d.text((16, 14), 'SIDE (left)  red=spec target  nose left', font=F, fill=(0, 0, 0))
d.text((16, 30), 'canopy peak s4.9/y1.42, fin tip y3.53, nozzle end s19.4', font=F, fill=(0, 0, 0))
im.save(os.path.join(V2, 'overlay_side.png'))
jobs.append('overlay_side.png')
# front
im = load_white(os.path.join(V2, 'ortho_front_raw.png'))
d = ImageDraw.Draw(im)
s = W/SCALES['front']
draw_poly(d, [S_front(x, z) for (x, z) in front_box])
draw_poly(d, [S_front(x, z) for (x, z) in front_canopy])
draw_poly(d, [S_front(x, z) for (x, z) in front_spine])
for sgn in (-1, 1):
    draw_poly(d, [S_front(sgn*2.10, 0.40), S_front(sgn*6.53, 0.323)])  # wing
    draw_poly(d, [S_front(sgn*1.35, 0.60), S_front(sgn*1.35, 3.53)])   # fin
    x0, x1 = sgn*1.10, sgn*2.10
    rect = [S_front(x0, -0.75), S_front(x0, 0.55), S_front(x1, 0.55), S_front(x1, -0.75), S_front(x0, -0.75)]
    draw_poly(d, rect)
    # aft duct bottom envelope (-0.80) visible below inlet bottom
    draw_poly(d, [S_front(sgn*1.08, -0.80), S_front(sgn*2.12, -0.80)])
    d.line([S_front(sgn*1.40, -0.70), S_front(sgn*1.40, -1.775)], fill=(255, 0, 0), width=3)
    d.line([S_front(0, -0.62), S_front(0, -1.92)], fill=(255, 0, 0), width=3)
d.text((16, 14), 'FRONT (from nose)  red=spec target  mirrored symmetric', font=F, fill=(0, 0, 0))
d.text((16, 30), 'fuselage +-2.15 / canopy w0.95 / inlet rects (duct bottom -0.80 line)', font=F, fill=(0, 0, 0))
im.save(os.path.join(V2, 'overlay_front.png'))
jobs.append('overlay_front.png')

# ---------- sheet ----------
tiles = [('front_level', 'front level'), ('side', 'side'), ('top', 'top'),
         ('bottom', 'bottom'), ('tqf', '3/4 front'), ('tqr', '3/4 rear')]
thumbs = []
for key, label in tiles:
    t = Image.open(os.path.join(V2, 'preview_%s.png' % key)).convert('RGB').resize((640, 360))
    td = ImageDraw.Draw(t)
    td.rectangle([0, 0, 200, 22], fill=(255, 255, 255))
    td.text((8, 5), label, font=F, fill=(0, 0, 0))
    thumbs.append(t)
sheet = Image.new('RGB', (640*2+30, 360*3+40+30), (255, 255, 255))
for i, t in enumerate(thumbs):
    sheet.paste(t, ((i % 2)*(640+10)+10, (i//2)*(360+10)+10))
sd = ImageDraw.Draw(sheet)
sd.text((10, sheet.height-22), 'F-15C v2 round8 perspectives (Workbench + 4-point). src/models/f15c_v2.glb', font=F, fill=(0, 0, 0))
sheet.save(os.path.join(V2, 'sheet.png'))
jobs.append('sheet.png')

# ---------- GLB audit (names/materials/tris, read-only parse) ----------
glb = os.path.join(WS, 'src', 'models', 'f15c_v2.glb')
with open(glb, 'rb') as f:
    magic, ver, ln = struct.unpack('<III', f.read(12))
    clen, ctype = struct.unpack('<II', f.read(8))
    js = json.loads(f.read(clen).decode('utf-8'))
mats = [m.get('name') for m in js.get('materials', [])]
nodes = [n.get('name') for n in js.get('nodes', [])]
tris = 0
for m in js.get('meshes', []):
    for p in m.get('primitives', []):
        ia = p.get('indices')
        if ia is None:
            continue
        acc = js['accessors'][ia]
        tris += acc['count']//3
print('GLB materials:', mats)
print('GLB nodes:', nodes)
print('GLB tris:', tris)
print('wrote:', jobs)
