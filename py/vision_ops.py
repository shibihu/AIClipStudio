# py/vision_ops.py — OpenCV frame analysis: scene detection, frame extraction,
# motion/color stats. Pure analysis only — ffmpeg keeps doing encoding.
import os

from common import ApiError, ModuleGate, require, envelope, clamp

cv_gate = ModuleGate("cv2")


def _cap(src):
    cv = cv_gate.get()
    cap = cv.VideoCapture(src)
    if not cap.isOpened():
        raise ApiError(f"OpenCV cannot open '{src}' (unsupported codec/path?)")
    return cap


@envelope
def scenes(d):
    """{input, threshold?} — cut list [t] between neighboring frames whose
    HSV-histogram distance jumps. threshold default 0.35 (0..1 sensitivity)."""
    cv = cv_gate.get()
    src = d.get("input")
    if not src:
        raise ApiError("missing input")
    thr = clamp(require(d, "threshold", cast=float, default=0.35)["threshold"] or 0.35, 0.05, 0.95)
    cap = _cap(src)
    fps = cap.get(cv.CAP_PROP_FPS) or 30.0
    cuts, prev_hist, frame_idx = [], None, 0
    step = max(1, int(round(fps / 8)))  # analyze ~8 fps — cheap yet accurate enough
    try:
        while True:
            ok = cap.grab()
            if not ok:
                break
            if frame_idx % step == 0:
                okf, frame = cap.retrieve()
                if not okf:
                    break
                hsv = cv.cvtColor(cv.resize(frame, (160, 90)), cv.COLOR_BGR2HSV)
                hist = cv.calcHist([hsv], [0, 1], None, [18, 8], [0, 180, 0, 256])
                cv.normalize(hist, hist, 0, 1, cv.NORM_MINMAX)
                if prev_hist is not None:
                    dist = cv.compareHist(prev_hist, hist, cv.HISTCMP_CHISQR_ALT)
                    # chi-square grows with change; small enough numbers here
                    # roughly map to a 0..1-ish gate after scaling
                    dist = min(1.0, dist / 50.0)
                    if dist > thr:
                        cuts.append({"time": round(frame_idx / fps, 3),
                                     "score": round(dist, 3)})
                prev_hist = hist
            frame_idx += 1
    finally:
        cap.release()
    # merge cuts closer than 0.8s apart → keep the strongest of each cluster
    merged = []
    for c in cuts:
        if merged and c["time"] - merged[-1]["time"] < 0.8:
            if c["score"] > merged[-1]["score"]:
                merged[-1] = c
        else:
            merged.append(c)
    return {"scenes": merged, "count": len(merged), "fps": round(fps, 3)}


@envelope
def frames(d):
    """{input, count?, outDir?, prefix?} — extract evenly spaced JPEG frames."""
    cv = cv_gate.get()
    src = d.get("input")
    out_dir = d.get("outDir")
    if not src or not out_dir:
        raise ApiError("need input and outDir")
    os.makedirs(out_dir, exist_ok=True)
    n = clamp(require(d, "count", cast=int, default=8)["count"] or 8, 1, 240)
    import re
    prefix = re.sub(r"\W+", "_", os.path.basename(out_dir)) or "frame"
    cap = _cap(src)
    total = int(cap.get(cv.CAP_PROP_FRAME_COUNT) or 0)
    fps = cap.get(cv.CAP_PROP_FPS) or 30.0
    if total <= 0:
        raise ApiError("frame count unknown (streamed source?), use ffmpeg instead")
    picked = sorted({int(round(i * (total - 1) / max(1, n - 1))) for i in range(n)})
    out, idx = [], 0
    try:
        while True:
            ok = cap.grab()
            if not ok or len(out) >= len(picked):
                break
            if idx == picked[len(out)]:
                okf, frame = cap.retrieve()
                if okf:
                    name = os.path.join(out_dir, f"{prefix}-{len(out):04d}.jpg")
                    cv.imwrite(name, frame, [cv.IMWRITE_JPEG_QUALITY, 88])
                    if os.path.isfile(name):
                        out.append(name)
            idx += 1
    finally:
        cap.release()
    if not out:
        raise ApiError("no frames could be extracted")
    return {"frames": out, "count": len(out), "fps": round(fps, 3)}


@envelope
def analyze(d):
    """{input} — cheap whole-video stats: size, fps, mean motion, brightness."""
    cv = cv_gate.get()
    src = d.get("input")
    if not src:
        raise ApiError("missing input")
    cap = _cap(src)
    fps = cap.get(cv.CAP_PROP_FPS) or 30.0
    w = int(cap.get(cv.CAP_PROP_FRAME_WIDTH) or 0)
    h = int(cap.get(cv.CAP_PROP_FRAME_HEIGHT) or 0)
    motion, bright, prev, n = 0.0, 0.0, None, 0
    step = max(1, int(round(fps / 4)))  # sample 4 fps
    idx = 0
    try:
        while True:
            ok = cap.grab()
            if not ok or n >= 300:
                break
            if idx % step == 0:
                okf, frame = cap.retrieve()
                if not okf:
                    break
                small = cv.resize(cv.cvtColor(frame, cv.COLOR_BGR2GRAY), (80, 45))
                if prev is not None:
                    motion += abs(cv.mean(cv.absdiff(small, prev))[0])
                bright += cv.mean(small)[0]
                prev = small
                n += 1
            idx += 1
    finally:
        cap.release()
    if not n:
        raise ApiError("no frames readable")
    return {
        "width": w, "height": h, "fps": round(fps, 3),
        "avg_motion": round(motion / n / 255, 4),
        "avg_brightness": round(bright / n / 255, 4),
        "samples": n,
    }
