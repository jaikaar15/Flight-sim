"""Generates app/Slipstream.icns — dark squircle, amber slipstream marks, delta-wing jet."""
import math, os, subprocess, shutil
from PIL import Image, ImageDraw, ImageFilter

S = 1024
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def squircle_mask(size, r=0.225):
    m = Image.new('L', (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * r), fill=255)
    return m

img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
# background gradient (night-sky slate)
bg = Image.new('RGBA', (S, S))
px = bg.load()
for y in range(S):
    for x in range(S):
        t = y / S
        dx, dy = (x - S * 0.7) / S, (y - S * 0.25) / S
        glow = max(0.0, 1 - math.hypot(dx, dy) * 1.6)
        r = int(10 + 18 * (1 - t) + 70 * glow ** 2)
        g = int(14 + 22 * (1 - t) + 45 * glow ** 2)
        b = int(20 + 34 * (1 - t) + 20 * glow ** 2)
        px[x, y] = (r, g, b, 255)
inner = Image.new('RGBA', (S, S), (0, 0, 0, 0))
inner.paste(bg, (0, 0))
# horizon line
d = ImageDraw.Draw(inner)
d.line([(80, 690), (944, 610)], fill=(255, 179, 71, 60), width=3)
# contrail streaks (slipstream)
streaks = Image.new('RGBA', (S, S), (0, 0, 0, 0))
ds = ImageDraw.Draw(streaks)
for i, (y0, w, a) in enumerate([(560, 16, 230), (610, 10, 170), (655, 6, 110)]):
    ds.line([(110, y0 + 70), (560, y0 - 70)], fill=(255, 179, 71, a), width=w)
streaks = streaks.filter(ImageFilter.GaussianBlur(1.2))
inner = Image.alpha_composite(inner, streaks)
# jet silhouette (delta wing, pointing up-right)
jet = Image.new('RGBA', (S, S), (0, 0, 0, 0))
dj = ImageDraw.Draw(jet)
cx, cy, ang = 640, 420, math.radians(-32)
def P(x, y):
    return (cx + x * math.cos(ang) - y * math.sin(ang), cy + x * math.sin(ang) + y * math.cos(ang))
body = [(250, 0), (150, -26), (-40, -34), (-60, -175), (-130, -190), (-110, -36), (-200, -30), (-240, -90), (-275, -92), (-262, 0),
        (-275, 92), (-240, 90), (-200, 30), (-110, 36), (-130, 190), (-60, 175), (-40, 34), (150, 26)]
dj.polygon([P(x, y) for x, y in body], fill=(236, 240, 244, 255))
dj.polygon([P(x, y) for x, y in [(175, -12), (110, -18), (110, 18), (175, 12)]], fill=(40, 52, 66, 255))
shadow = jet.filter(ImageFilter.GaussianBlur(14))
sh = Image.new('RGBA', (S, S), (0, 0, 0, 0)); sh.paste((0, 0, 0, 150), (0, 0), shadow.split()[3])
inner = Image.alpha_composite(inner, sh)
inner = Image.alpha_composite(inner, jet)
# rim
rim = Image.new('RGBA', (S, S), (0, 0, 0, 0))
ImageDraw.Draw(rim).rounded_rectangle([3, 3, S - 4, S - 4], radius=int(S * 0.225), outline=(255, 255, 255, 40), width=4)
inner = Image.alpha_composite(inner, rim)
img.paste(inner, (0, 0), squircle_mask(S))
# inset to Apple icon grid (824px content)
canvas = Image.new('RGBA', (S, S), (0, 0, 0, 0))
canvas.paste(img.resize((824, 824), Image.LANCZOS), (100, 100))

iconset = os.path.join(root, 'app', 'Slipstream.iconset')
shutil.rmtree(iconset, ignore_errors=True); os.makedirs(iconset)
for sz in [16, 32, 128, 256, 512]:
    canvas.resize((sz, sz), Image.LANCZOS).save(os.path.join(iconset, f'icon_{sz}x{sz}.png'))
    canvas.resize((sz * 2, sz * 2), Image.LANCZOS).save(os.path.join(iconset, f'icon_{sz}x{sz}@2x.png'))
subprocess.run(['iconutil', '-c', 'icns', iconset, '-o', os.path.join(root, 'app', 'Slipstream.icns')], check=True)
shutil.rmtree(iconset)
canvas.save(os.path.join(root, 'app', 'icon_preview.png'))
print('icon written')
