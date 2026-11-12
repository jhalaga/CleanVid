"""Compose store-size graphics from real extension smoke-test screenshots.

No UI is redrawn. The panel image uses mocked caption detections from the
smoke test, identified as an example in the graphic.
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "store-assets"
OUT.mkdir(exist_ok=True)
FONT = Path("C:/Windows/Fonts")


def font(size, bold=False):
    return ImageFont.truetype(str(FONT / ("segoeuib.ttf" if bold else "segoeui.ttf")), size)


def canvas():
    image = Image.new("RGB", (1280, 800), "#0b1118")
    draw = ImageDraw.Draw(image)
    draw.ellipse((800, -270, 1560, 550), fill="#112b2b")
    draw.ellipse((-400, 530, 550, 1350), fill="#102330")
    return image, draw


image, draw = canvas()
icon = Image.open(ROOT / "icons/icon128.png").convert("RGBA")
image.paste(icon, (68, 58), icon)
draw.text((218, 87), "CleanVid", font=font(44, True), fill="#e9f1f8")
draw.multiline_text((78, 236), "Keep the video\nin view.", font=font(66, True), fill="#e9f1f8", spacing=5)
draw.text((82, 430), "A compact profanity filter for YouTube.", font=font(26), fill="#8fa3b7")
for y, heading, detail in [
    (510, "One compact panel", "Open it from the toolbar or floating shield."),
    (585, "A clickable timeline", "Jump to detected moments; expand words on demand."),
    (660, "Local audio analysis", "Optional speech models run on your computer."),
]:
    draw.ellipse((83, y+9, 91, y+17), fill="#4fe3b3")
    draw.text((109, y), heading, font=font(23, True), fill="#e9f1f8")
    draw.text((109, y+30), detail, font=font(19), fill="#8fa3b7")

source = Image.open(ROOT / "tools/fixtures/e2e-panel-detail.png").convert("RGB")
# The detail capture adds an 8 px inset and includes the floating button.
# Isolate the panel itself, leaving unrelated YouTube content out of the art.
panel = source.crop((8, 8, source.width-8, source.height-76))
panel = panel.resize((406, round(panel.height*406/panel.width)), Image.Resampling.LANCZOS)
mask = Image.new("L", panel.size)
ImageDraw.Draw(mask).rounded_rectangle((0, 0, panel.width, panel.height), radius=20, fill=255)
image.paste(panel, (790, 142), mask)
draw.text((790, 691), "Caption-mode example", font=font(19, True), fill="#4fe3b3")
draw.text((790, 721), "Mocked detections from the smoke test", font=font(16), fill="#8fa3b7")
image.save(OUT / "01-compact-panel.png")

image, draw = canvas()
draw.text((58, 27), "CleanVid settings", font=font(30, True), fill="#e9f1f8")
draw.text((58, 68), "Choose local models, censoring style and playback controls.", font=font(21), fill="#8fa3b7")
settings = Image.open(ROOT / "tools/fixtures/e2e-options.png").convert("RGB")
settings = settings.crop((0, 0, settings.width, 660))
settings = settings.resize((1164, 660), Image.Resampling.LANCZOS)
mask = Image.new("L", settings.size)
ImageDraw.Draw(mask).rounded_rectangle((0, 0, settings.width, settings.height), radius=14, fill=255)
image.paste(settings, (58, 120), mask)
image.save(OUT / "02-settings.png")
icon.save(OUT / "icon128.png")
tile = Image.new("RGB", (440, 280), "#0b1118")
td = ImageDraw.Draw(tile)
td.ellipse((245, -105, 570, 220), fill="#112b2b")
small_icon = icon.resize((72, 72), Image.Resampling.LANCZOS)
tile.paste(small_icon, (28, 30), small_icon)
td.text((116, 42), "CleanVid", font=font(36, True), fill="#e9f1f8")
td.text((32, 134), "Profanity off.", font=font(30, True), fill="#e9f1f8")
td.text((32, 174), "Everything else on.", font=font(30, True), fill="#4fe3b3")
td.text((32, 235), "A local profanity filter for YouTube", font=font(18), fill="#8fa3b7")
tile.save(OUT / "03-small-promo.png")
for path in sorted(OUT.glob("*.png")):
    with Image.open(path) as item:
        print(f"{path.name}: {item.width} x {item.height}")
