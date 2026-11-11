# py/caption_ops.py — CaptionRemovalEngine: burn-in caption (subtitle) detection
# and region-only removal for AIClipStudio.
#
# Detection approaches the problem in three stages:
#   1. GEOMETRIC PRIOR — burned-in subtitles live almost always in a horizontal
#      band (bottom ~35% by default, configurable). All work is restricted to
#      that band, which already rejects ~90% of false positives in the frame.
#   2. TEXT-LIKE REGION CANDIDATES — per sampled frame, inside the band, an
#      adaptive-threshold + morphology pass finds bright text-shaped outlines.
#      Boxes are filtered by size/aspect/fill heuristics. OpenCV does NOT do
#      general-purpose OCR — it only proposes candidate boxes.
#   3. OCR REFINE (optional) — when `rapidocr-onnxruntime` is installed it
#      reads the band with a real OCR engine and any box that yields text
#      gets high confidence; OCR-less candidate boxes keep a lower confidence
#      so the caller can decide (nothing destructive runs on low confidence).
#
# Removed captions are rendered by ffmpeg (region blur / drawbox / delogo via
# a filter graph the Node side builds) — detection itself never destructs.
# The `remove` endpoint here is a synchronous small-clip helper using
# MoviePy/OpenCV writeout; production renders go through the ffmpeg graph.
#
# OCR install (optional, enables high-confidence detection):
#   pip install rapidocr-onnxruntime onnxruntime
import os

from common import ApiError, ModuleGate, envelope, require, clamp

cv_gate = ModuleGate("cv2")
ocr_state = {"tried": False, "mod": None, "error": None}


def _ocr():
    """Lazy OCR engine loader. None = unavailable (detection still works,
    just with reduced confidence). Results cached per process.
    The readable English label of what's missing matters more than speed."""
    if not ocr_state["tried"]:
        ocr_state["tried"] = True
        try:
            from rapidocr_onnxruntime import RapidOCR  # noqa: F401
            ocr_state["mod"] = RapidOCR()
        except Exception as e:
            ocr_state["error"] = str(e)
    return ocr_state["mod"]


# ---------------------------------------------------------------- helpers ---

def _open(src):
    cv = cv_gate.get()
    cap = cv.VideoCapture(src)
    if not cap.isOpened():
        raise ApiError(f"OpenCV cannot open '{src}'")
    return cv, cap


class _Box:
    __slots__ = ("x", "y", "w", "h", "hits", "frames", "conf")

    def __init__(self, x, y, w, h, conf):
        self.x, self.y, self.w, self.h = x, y, w, h
        self.hits = 1
        self.frames = 1
        self.conf = conf


def _iou(a, b):
    ax2, ay2 = a.x + a.w, a.y + a.h
    bx2, by2 = b.x + b.w, b.y + b.h
    ix = max(0, min(ax2, bx2) - max(a.x, b.x))
    iy = max(0, min(ay2, by2) - max(a.y, b.y))
    inter = ix * iy
    if inter <= 0:
        return 0.0
    return inter / float(a.w * a.h + b.w * b.h - inter)


def _candidates(cv, gray_band, x_off, y_off, width, band_h):
    """Bright text-shaped boxes inside the band. Returns [(x,y,w,h,conf)]."""
    bl = cv.adaptiveThreshold(gray_band, 255, cv.ADAPTIVE_THRESH_MEAN_C,
                              cv.THRESH_BINARY, 21, -6)
    if (bl > 0).sum() / bl.size > 0.55:
        # bright background (sky/white wall) — thresholds invert on subtitles
        bl = cv.adaptiveThreshold(gray_band, 255, cv.ADAPTIVE_THRESH_MEAN_C,
                                  cv.THRESH_BINARY_INV, 21, -6)
    kernel = cv.getStructuringElement(cv.MORPH_RECT, (int(max(3, band_h // 18)), 3))
    dil = cv.dilate(bl, kernel, iterations=2)
    boxes = []
    hi, wid = gray_band.shape
    try:
        contours, _ = cv.findContours(dil, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)
    except ValueError:
        _, contours, _ = cv.findContours(dil, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)
    for c in contours:
        bx, by, bw, bh = cv.boundingRect(c)
        if bw < width * 0.10 or bw > width * 0.92:
            continue
        if bh < band_h * 0.02 or bh > band_h * 0.75:
            continue
        if bw / float(bh) < 2.0:  # single letters are not subtitle lines
            continue
        fill = cv.countNonZero(bl[by:by + bh, bx:bx + bw]) / float(bw * bh)
        if not (0.04 <= fill <= 0.75):
            continue
        boxes.append((bx + x_off, by + y_off, bw, bh, 0.6))
    return boxes


def _ocr_candidates(cv, frame, y0, y1, width):
    """OCR the band; boxes with recognized text get 0.94 confidence."""
    eng = _ocr()
    if not eng:
        return []
    crop = frame[y0:y1]
    scale = 2.0 if width < 900 else 1.0
    if scale != 1.0:
        crop = cv.resize(crop, None, fx=scale, fy=scale, interpolation=cv.INTER_CUBIC)
    try:
        res, _ = eng(crop)
    except Exception:
        return []
    out = []
    for item in (res or []):
        try:
            quad, text, score = item[0], item[1], float(item[2])
        except (IndexError, TypeError, ValueError):
            continue
        text = str(text).strip()
        if len(text) < 1 or score < 0.55:
            continue
        xs = [p[0] for p in quad]; ys = [p[1] for p in quad]
        bx0, bx1 = min(xs) / scale, max(xs) / scale
        by0, by1 = min(ys) / scale, max(ys) / scale
        out.append((int(bx0), int(by0), int(bx1 - bx0), int(by1 - by0),
                    round(min(0.94, 0.6 + 0.34 * score), 2)))
    return out


def _pad_box(x, y, w, h, width, height, margin=0.25):
    """Grow a box slightly — small crops lose glyph edges during removal."""
    gw = int(w * margin); gh = int(h * margin)
    gx = max(0, x - gw); gy = max(0, y - gh)
    return gx, gy, min(width, x + w + gw) - gx, min(height, y + h + gh) - gy


# -------------------------------------------------------------- endpoints ---

@envelope
def detect(d):
    """{input, sampleFps?, band?, manual?, minHits?, useOcr?, pad?} →
    {regions:[{start,end,x,y,width,height,confidence,samples}], width, height,
     bandUsed:{y0,y1}, ocr:{available}} — pixel coords in source resolution
     plus normalized xN/yN/wN/hN for portability between resolutions."""
    cv, cap = _open(d.get("input"))
    sample_fps = clamp(require(d, "sampleFps", cast=float, default=4)["sampleFps"] or 4, 1, 15)
    min_hits = clamp(require(d, "minHits", cast=int, default=2)["minHits"] or 2, 1, 100)
    use_ocr = bool(d.get("useOcr", True))
    fps = cap.get(cv.CAP_PROP_FPS) or 30.0
    width = int(cap.get(cv.CAP_PROP_FRAME_WIDTH) or 0)
    height = int(cap.get(cv.CAP_PROP_FRAME_HEIGHT) or 0)
    if not (width and height):
        cap.release()
        raise ApiError("unknown video dimensions")

    step = max(1, int(round(fps / sample_fps)))
    band_top = int(height * float(d.get("bandTop", 0.60)))
    band_bot = int(height * float(d.get("bandBottom", 0.99)))
    manual = d.get("manual")
    manual_box = None
    if isinstance(manual, dict):
        try:
            manual_box = (int(manual["x"]), int(manual["y"]), int(manual["w"]), int(manual["h"]))
        except (KeyError, TypeError, ValueError):
            manual_box = None

    pad = float(d.get("pad", 0.25))
    tracks = {}          # key → _Box-like dict with time window
    order = []
    ocr_used = False
    idx = 0
    try:
        while True:
            ok = cap.grab()
            if not ok:
                break
            if idx % step:
                idx += 1
                continue
            okf, frame = cap.retrieve()
            idx += 1
            if not okf:
                break
            t = idx / max(fps, 0.001)
            gray = cv.cvtColor(frame, cv.COLOR_BGR2GRAY)
            band_h = band_bot - band_top
            if manual_box:
                mx, my, mw, mh = manual_box
                cands = [(mx, my, mw, mh, 0.99)]
            else:
                cands = _candidates(cv, gray[band_top:band_bot], 0, band_top, width, band_h)
                if use_ocr:
                    oc = _ocr_candidates(cv, frame, band_top, band_bot, width)
                    if oc:
                        ocr_used = True
                    cands = cands + oc
            # track against open boxes (IoU), else open a new one
            for (bx, by, bw, bh, conf) in cands:
                box = dict(x=bx, y=by, w=bw, h=bh)
                match = None
                best = 0.0
                for tid in list(tracks):
                    tr = tracks[tid]
                    i = _iou(_Box(tr["x"], tr["y"], tr["w"], tr["h"], 0),
                             _Box(bx, by, bw, bh, 0))
                    if i > best:
                        best, match = i, tid
                if best >= 0.45:
                    tr = tracks[match]
                    tr["t0"] = min(tr["t0"], t)
                    tr["t1"] = max(tr["t1"], t)
                    tr["hits"] += 1
                    if conf > tr["conf"]:
                        # refined (OCR) union: keep the better box geometry
                        tr.update(x=bx, y=by, w=bw, h=bh, conf=max(tr["conf"], conf))
                    else:
                        tr["x"] = min(tr["x"], bx); tr["y"] = min(tr["y"], by)
                        tr["w"] = max(tr["w"], bx + bw) - tr["x"]
                        tr["h"] = max(tr["h"], by + bh) - tr["y"]
                        tr["conf"] = max(tr["conf"], conf * 0.98)
                else:
                    tid = f"f{len(tracks)}_{int(t * 1000)}"
                    tracks[tid] = dict(x=bx, y=by, w=bw, h=bh,
                                       t0=t, t1=t, hits=1, conf=conf)
                    order.append(tid)
            # no pruning — minHits at emit time filters spurious tracks; a
            # caption gone for minutes must still report its real time range
    finally:
        cap.release()

    regions = []
    for tid in order:
        tr = tracks.get(tid)
        if not tr or tr["hits"] < min_hits:
            continue
        x, y, w, h = tr["x"], tr["y"], tr["w"], tr["h"]
        if d.get("pad") is not False:
            x, y, w, h = _pad_box(x, y, w, h, width, height, pad)
        regions.append({
            "start": round(tr["t0"], 3), "end": round(tr["t1"] + 1.0 / sample_fps, 3),
            "x": x, "y": y, "width": w, "height": h,
            "xN": round(x / width, 4), "yN": round(y / height, 4),
            "wN": round(w / width, 4), "hN": round(h / height, 4),
            "confidence": round(tr["conf"], 2),
            "samples": tr["hits"],
        })
    regions.sort(key=lambda r: r["start"])
    # merge near-identical overlapping ranges on the same geometry
    merged = []
    for r in regions:
        if merged and abs(merged[-1]["start"] - r["start"]) < 0.15 and r["y"] < merged[-1]["y"] + merged[-1]["height"]:
            m = merged[-1]
            m["end"] = max(m["end"], r["end"])
            ax0, ay0 = min(m["x"], r["x"]), min(m["y"], r["y"])
            ax1 = max(m["x"] + m["width"], r["x"] + r["width"])
            ay1 = max(m["y"] + m["height"], r["y"] + r["height"])
            m["x"], m["y"], m["width"], m["height"] = ax0, ay0, ax1 - ax0, ay1 - ay0
            m["confidence"] = max(m["confidence"], r["confidence"])
        else:
            merged.append(dict(r))
    eng = _ocr()
    return {
        "regions": merged,
        "count": len(merged),
        "width": width, "height": height,
        "band": {"top": band_top, "bottom": band_bot},
        "ocr": {"available": bool(eng),
                "used": ocr_used,
                "install": "pip install rapidocr-onnxruntime onnxruntime"},
    }


@envelope
def remove_preview(d):
    """Quick region-only removal proof on ONE frame: {input, regions:[…], t?}
    → writes <out> JPEG with all detected regions blurred. Lets the UI/user
    preview what removal will look like before a destructive render."""
    cv, cap = _open(d.get("input"))
    t = float(require(d, "t", cast=float, default=None)["t"] or 0)
    cap.set(cv.CAP_PROP_POS_MSEC, max(0, t * 1000))
    okf, frame = cap.read()
    cap.release()
    if not okf:
        raise ApiError("cannot read frame at t")
    out = require(d, "output", cast=str, default=None)["output"]
    if not out:
        raise ApiError("missing output path")
    method = str(d.get("method") or "blur").lower()
    strength = float(d.get("strength", 25))
    for r in d.get("regions") or []:
        try:
            x, y = int(r["x"]), int(r["y"])
            w, h = int(r["width"]), int(r["height"])
        except (KeyError, TypeError, ValueError):
            raise ApiError("region needs x,y,width,height")
        if w <= 0 or h <= 0 or x < 0 or y < 0 or x + w > frame.shape[1] or y + h > frame.shape[0]:
            raise ApiError(f"region out of bounds: {r}")
        roi = frame[y:y + h, x:x + w]
        if method == "solid":
            representation = roi.mean(axis=(0, 1)).astype(roi.dtype)
            frame[y:y + h, x:x + w] = representation
        elif method == "inpaint":
            mask = _text_mask(cv, roi)
            frame[y:y + h, x:x + w] = cv.inpaint(roi, mask, 7, cv.INPAINT_TELEA)
        else:  # blur (default), strength → gaussian sigma
            sigma = max(4.0, min(80.0, strength))
            roi2 = cv.GaussianBlur(roi, (0, 0), sigma)
            if method == "box":
                k = int(max(3, strength)) | 1
                roi2 = cv.blur(roi, (k, k))
            frame[y:y + h, x:x + w] = roi2
    os.makedirs(os.path.dirname(os.path.abspath(out)) or ".", exist_ok=True)
    cv.imwrite(out, frame, [cv.IMWRITE_JPEG_QUALITY, 90])
    return {"output": os.path.abspath(out), "regions": len(d.get("regions") or []),
            "method": method}


def _text_mask(cv, roi):
    """Mask of bright/dark glyph pixels for inpainting (not whole rect —
    keeps more background). Falls back to full-rect mask when flat."""
    gray = cv.cvtColor(roi, cv.COLOR_BGR2GRAY)
    _, m = cv.threshold(gray, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU)
    if m.mean() > 250 or m.mean() < 5:
        m[:] = 255
    return cv.dilate(m, cv.getStructuringElement(cv.MORPH_RECT, (5, 5)))


@envelope
def validate(d):
    """{before, after, regions?} — sample-matched frame diff check:
    inside every region the change must be significant (removal happened);
    outside the regions it must stay small (content intact). Non-exact frame
    matching: videos of same length, sampled at the same fractions."""
    cv, cap_a = _open(d.get("before"))
    _, cap_b = _open(d.get("after"))
    fa = int(cap_a.get(cv.CAP_PROP_FRAME_COUNT) or 0)
    fb = int(cap_b.get(cv.CAP_PROP_FRAME_COUNT) or 0)
    if not (fa and fb):
        raise ApiError("unknown frame counts")
    n = 10
    inside, outside, edges = [], [], []
    ok = True
    for i in range(1, n + 1):
        pa = int(fa * i / (n + 1)); pb = int(fb * i / (n + 1))
        cap_a.set(cv.CAP_PROP_POS_FRAMES, pa)
        cap_b.set(cv.CAP_PROP_POS_FRAMES, pb)
        _, ia = cap_a.read(); _, ib = cap_b.read()
        if not (ia is not None and ib is not None):
            continue
        if ia.shape != ib.shape:
            ok = False
            break
        diff = cv.absdiff(ia, ib).mean(axis=2)
        changed = diff > 12
        mask = None
        regions = d.get("regions") or []
        edge_drops = []
        for r in regions:
            try:
                x, y = int(r["x"]), int(r["y"])
                w, h = int(r["width"]), int(r["height"])
            except (KeyError, TypeError, ValueError):
                continue
            if mask is None:
                mask = changed.astype("uint8") * 0
            mask[y:y + h, x:x + w] |= changed[y:y + h, x:x + w].astype("uint8") * 1
            # edge-energy: strong blur/inpaint kills local gradients; pixel diff
            # alone underrates bright-glyph blur (glyph centers stay bright)
            ga = cv.Laplacian(cv.cvtColor(ia, cv.COLOR_BGR2GRAY), cv.CV_64F)
            gb2 = cv.Laplacian(cv.cvtColor(ib, cv.COLOR_BGR2GRAY), cv.CV_64F)
            # regional mean |Laplacian| inside each region
            roi_a = ga[y:y + h, x:x + w]; roi_b = gb2[y:y + h, x:x + w]
            ma = float(abs(roi_a).mean()); mb = float(abs(roi_b).mean())
            if ma > 1.0:
                edge_drops.append(max(0.0, 1.0 - mb / ma))
        if mask is not None:
            in_frac = float(mask.sum()) / mask.size
            inside.append(in_frac)
            inv = (mask == 0)
            if inv.sum() > 0:
                outside.append(float(diff[inv].mean()))
        if edge_drops:
            edges.append(sum(edge_drops) / len(edge_drops))
    cap_a.release(); cap_b.release()
    if not inside and not edges:
        return {"ok": False, "error_hint": "no comparable frames", "inside_avg": 0, "outside_avg": None}
    in_avg = sum(inside) / len(inside) if inside else 0.0
    out_avg = (sum(outside) / len(outside)) if outside else None
    edge_drop = (sum(edges) / len(edges)) if edges else None
    # inside must show real change (pixel change OR edge-energy collapse =
    # blur/inpaint removing glyph contrast); outside must stay near-quiet
    checks = {
        "regions_changed": bool(edge_drop and edge_drop > 0.35) or in_avg > 0.10,
        "outside_unchanged": out_avg is None or out_avg < 45,
        "same_shape": ok,
    }
    return {"ok": all(checks.values()), "checks": checks,
            "inside_avg": round(in_avg, 4), "outside_avg": None if out_avg is None else round(out_avg, 3),
            "edge_drop": None if edge_drop is None else round(edge_drop, 4),
            "samples": len(inside) or len(edges)}
