# py/image_ops.py — Pillow (thumbnails, text overlays, stickers) + python-lottie
# (animated sticker prep). Sticker path: Lottie JSON → animated GIF; the Node
# server then composites the GIF onto the clip with the existing ffmpeg overlay
# render (keeps one compositing path, avoids moviepy doing it worse).
import os
import re

from common import ApiError, ModuleGate, require, safe_out, envelope, clamp

pil_gate = ModuleGate("PIL")
lottie_gate = ModuleGate("lottie")

FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/data/data/com.termux/files/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "C:/Windows/Fonts/arialbd.ttf",
]


def _find_font(size):
    PIL = pil_gate.get()
    from PIL import ImageFont
    for c in FONT_CANDIDATES:
        try:
            return ImageFont.truetype(c, size)
        except Exception:
            continue
    return ImageFont.load_default(size=size) if hasattr(ImageFont, "load_default") \
        else ImageFont.load_default()


@envelope
def thumbnail(d):
    """{input(image/video frame image or png/jpg), output?, width?}"""
    PIL = pil_gate.get()
    from PIL import Image
    src = d.get("input")
    out = safe_out(d.get("output") or (src and re.sub(r"\?\.(jpg|jpeg|png)$|$", ".thumb.jpg", src)))
    width = clamp(require(d, "width", cast=int, default=240)["width"] or 240, 16, 4096)
    try:
        img = Image.open(src)
        img = img.convert("RGB")
    except Exception as e:
        raise ApiError(f"cannot open image: {e}", 500)
    ratio = width / max(1, img.width)
    img = img.resize((width, max(2, int(round(img.height * ratio)))), Image.LANCZOS)
    img.save(out, "JPEG", quality=88)
    return {"output": out, "width": img.width, "height": img.height}


@envelope
def text_png(d):
    """{text, output, width?, height?, size?, color?, bg?, align?} — render text
    onto a transparent PNG. Used for sticker-style overlays the AI can place."""
    pil_gate.get()
    from PIL import Image, ImageDraw
    text = str(d.get("text") or "")
    if not text.strip():
        raise ApiError("text is empty")
    out = safe_out(d.get("output"))
    fs = require(d, "width", "height", "size", cast=int,
                 default=None, src="text_png payload")
    width = clamp(fs["width"] or 0, 0, 4096)
    height = clamp(fs["height"] or 0, 0, 4096)
    size = clamp(fs["size"] or 64, 8, 400)
    color = str(d.get("color") or "#FFFFFF")
    bg = d.get("bg")
    align = str(d.get("align") or "center")
    font = _find_font(size)
    dummy = Image.new("RGBA", (8, 8))
    draw = ImageDraw.Draw(dummy)
    # wrap text if a width was forced
    lines = []
    max_line = max(4, int(width / max(1, size * 0.55))) if width else 2048
    for raw in text.split("\n"):
        cur = ""
        for word in raw.split(" "):
            cand = (cur + " " + word).strip()
            if len(cand) > max_line and cur:
                lines.append(cur)
                cur = word
            else:
                cur = cand
        if cur:
            lines.append(cur)
    # measure
    wmax, htot = 0, 0
    line_h = []
    for line in lines:
        box = draw.textbbox((0, 0), line, font=font)
        lw, lh = box[2] - box[0], box[3] - box[1]
        wmax = max(wmax, lw)
        htot += lh + max(2, int(size * 0.18))
        line_h.append(lh)
    width = width or clamp(wmax + size * 0.6, 8, 4096)
    height = height or clamp(htot + size * 0.6, 8, 4096)
    img = Image.new("RGBA", (int(width), int(height)),
                    tuple((*_hex_to_rgb(bg), 255)) if bg else (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    y = max(4, int((height - htot) / 2))
    for line in lines:
        box = draw.textbbox((0, 0), line, font=font)
        lw = box[2] - box[0]
        x = {"center": max(2, int((width - lw) / 2)),
             "left": int(size * 0.3),
             "right": max(2, int(width - lw - size * 0.3))}.get(align, int((width - lw) / 2))
        draw.text((x, y), line, font=font, fill=_hex_to_rgb(color))
        y += line_h[lines.index(line)] + max(2, int(size * 0.18))
    img.save(out, "PNG")
    return {"output": out, "width": img.width, "height": img.height, "lines": len(lines)}


def _hex_to_rgb(s):
    s = str(s or "#FFFFFF").lstrip("#")
    if len(s) == 3:
        s = "".join(c * 2 for c in s)
    try:
        return tuple(int(s[i:i + 2], 16) for i in (0, 2, 4))
    except ValueError:
        return (255, 255, 255)


@envelope
def sticker(d):
    """{input(image or single-frame video extraction), output, round?, punch?} —
    cut out a sticker-style PNG: rounded corners + slight white outline."""
    pil_gate.get()
    from PIL import Image, ImageDraw, ImageFilter
    src, out = d.get("input"), safe_out(d.get("output"))
    if src == out:
        raise ApiError("output must differ from input")
    punch = int(clamp(require(d, "punch", cast=int, default=24)["punch"] or 24, 0, 200))
    try:
        img = Image.open(src).convert("RGBA")
    except Exception as e:
        raise ApiError(f"cannot open image: {e}", 500)
    mask = Image.new("L", img.size, 0)
    md = ImageDraw.Draw(mask)
    radius = punch
    md.rounded_rectangle([0, 0, img.width - 1, img.height - 1], radius=radius, fill=255)
    outline = Image.new("RGBA", img.size, (255, 255, 255, 0))
    od = ImageDraw.Draw(outline)
    od.rounded_rectangle([0, 0, img.width - 1, img.height - 1], radius=radius,
                         fill=(255, 255, 255, 255))
    outline = outline.filter(ImageFilter.MaxFilter(7))
    canvas = Image.alpha_composite(outline, img)
    canvas.putalpha(Image.composite(mask, Image.new("L", mask.size, 0),
                                    mask.point(lambda v: min(v, 255))))
    canvas.save(out, "PNG")
    return {"output": out}


@envelope
def lottie_prep(d):
    """{lottie (path or inline JSON), output GIF, width?, fps?} — parse and
    rasterize a Lottie JSON into an animated GIF for the ffmpeg overlay render.
    Degrades to a single still frame when the export cannot animate."""
    lottie_gate.get()
    from lottie import objects
    from lottie.exporters import exporters
    data = d.get("lottie")
    out = safe_out(d.get("output"))
    fps = clamp(require(d, "fps", cast=int, default=24)["fps"] or 24, 4, 60)
    try:
        if isinstance(data, (dict, list)):
            anim = objects.LottieAnimation.from_dict(data)
        else:
            anim = objects.LottieAnimation.from_file(data)
    except Exception as e:
        raise ApiError(f"cannot read Lottie JSON: {e}", 500)
    try:
        for name in ("gif", "apng"):
            if name in exporters.get_exporters():
                break
        exporter = exporters.get_exporters()["gif"]
        exporter(anim, out, fps=fps)
    except Exception as e:
        raise ApiError(f"Lottie rasterization failed: {e}", 500)
    if not os.path.isfile(out):
        raise ApiError("Lottie export produced no file", 500)
    return {"output": out, "fps": fps}

