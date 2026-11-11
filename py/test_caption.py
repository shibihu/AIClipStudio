# py/test_caption.py — integration tests for the CaptionRemovalEngine.
# Runs WITHOUT the HTTP service: direct function calls.
#   AICLIP_PY=python3 AICLIP_FFMPEG=./vendor/ffmpeg-arm64 python3 py/test_caption.py
# Fixture: 5s 640x360 clip, solid background, burned white caption
# "HELLO WORLD THIS IS A SUBTITLE" bottom-center (MarginV≈24), aac audio tone.
# Expected caption box ≈ y 300-336, x≈135-505 (full-width after padding).
# Exit code 0 = all passed.
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
ROOT = os.path.dirname(HERE)
FFMPEG = os.environ.get("AICLIP_FFMPEG") or os.path.join(ROOT, "vendor", "ffmpeg-arm64")
if not os.path.isfile(FFMPEG):
    FFMPEG = FFMPEG.replace("--arm64", "--amd64").replace("arm64", "amd64")

import caption_ops  # noqa: E402

PASS = []
FAIL = []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(("PASS" if cond else "FAIL"), name, detail)


def make_fixture(dirpath, name="sample.mp4", audio_name="sample_audio.mp4"):
    ass = os.path.join(dirpath, "s.ass")
    with open(ass, "w", encoding="utf8") as f:
        f.write("""[Script Info]
ScriptType: v4.00+
PlayResX: 640
PlayResY: 360

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, Bold, Alignment, MarginL, MarginR, MarginV, BorderStyle, Encoding
Style: A,DejaVu Sans,30,&H00FFFFFF,&H00101010,1,2,40,40,24,1,1
[Events]
Format: Layer, Start, End, Style, MarginV, Text
Dialogue: 0,0:00:00.20,0:00:04.80,A,24,,HELLO WORLD THIS IS A SUBTITLE
""")
    out = os.path.join(dirpath, name)
    r = subprocess.run([FFMPEG, "-y", "-hide_banner", "-v", "error",
                        "-f", "lavfi", "-i",
                        "color=c=0x204056:size=640x360:rate=10:duration=5",
                        "-vf", f"subtitles={ass}:fontsdir={ROOT}/vendor/fonts,format=yuv420p",
                        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", out],
                       capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        raise RuntimeError(r.stderr[-300:])
    audio = os.path.join(dirpath, "sample_audio.mp4")
    r = subprocess.run([FFMPEG, "-y", "-hide_banner", "-v", "error",
                        "-i", out, "-f", "lavfi", "-i", "sine=frequency=440:duration=5",
                        "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac",
                        "-b:a", "64k", audio], capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        raise RuntimeError(r.stderr[-300:])
    return out, audio


def audio_hash(ffmpeg, path):
    pcm = path + ".pcm"
    subprocess.run([ffmpeg, "-y", "-hide_banner", "-v", "error", "-i", path,
                    "-map", "0:a", "-c:a", "pcm_s16le", "-f", "s16le", pcm],
                   capture_output=True, timeout=120, check=True)
    import hashlib
    with open(pcm, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def main():
    tmp = tempfile.mkdtemp(prefix="captest-")
    try:
        video, audio = make_fixture(tmp)  # audio: tone muxed over the caption video
        det = caption_ops.detect({"input": video, "sampleFps": 5})
        check("detect: ok", det.get("ok") is True)
        regions = det.get("regions") or []
        check("detect: caption found", len(regions) >= 1, json.dumps(regions[:2]))
        r = regions[0]
        check("detect: box in the bottom subtitle band", r["y"] >= 280 and r["y"] <= 320,
              f"y={r['y']} h={r['height']}")
        check("detect: aspect is a horizontal text line", r["width"] / float(r["height"]) >= 3,
              f"{r['width']}x{r['height']}")
        check("detect: normalized coords consistent",
              r["xN"] * det["width"] > 0, f"xN={r['xN']}")

        # remove preview: gaussian blur only inside the region
        pv = caption_ops.remove_preview({
            "input": video, "regions": [r], "t": 2.0, "method": "blur",
            "output": os.path.join(tmp, "blur.jpg"),
        })
        check("remove_preview: writes touched frame", os.path.isfile(pv.get("output", "")))
    finally:
        pass

    # ffmpeg region-blur render + validate + audio-hash on a manual graph
    regions = caption_ops.detect({"input": video, "sampleFps": 5})["regions"]
    r = regions[0]
    y0 = r["y"]; h0 = r["height"]
    graph = (f"[0:v]split[f0][s0];[f0]crop={r['width']}:{h0}:{r['x']}:{y0},gblur=sigma=16[b0];"
             f"[s0][b0]overlay=x={r['x']}:y={y0}[vout]")
    after = os.path.join(tmp, "after.mp4")
    subprocess.run([FFMPEG, "-y", "-hide_banner", "-v", "error", "-i", audio,
                    "-filter_complex", graph, "-map", "[vout]", "-map", "0:a?",
                    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
                    "-c:a", "copy", "-pix_fmt", "yuv420p", after],
                   capture_output=True, timeout=180, check=True)
    val = caption_ops.validate({"before": audio, "after": after,
                                "regions": [r]})
    check("validate: regions changed (edge drop)", bool(val.get("checks", {}).get("regions_changed")),
          json.dumps(val.get("checks")))
    check("validate: outside the region untouched",
          bool(val.get("checks", {}).get("outside_unchanged")))
    check("validate: same shape", bool(val.get("checks", {}).get("same_shape")))
    check("validate: overall ok", val.get("ok") is True)

    ha, hb = audio_hash(FFMPEG, audio), audio_hash(FFMPEG, after)
    check("audio: original voiceover untouched (bit-identical PCM)", ha == hb)

    # solid drawbox + delogo methods must render too (moving-caption variants
    # reuse the same per-window chains with distinct time ranges).
    # delogo needs its box 1px inside the frame edge -- same clamp caption.js uses
    dx = max(1, r["x"]); dy0 = max(1, y0)
    dwidth = min(r["width"], det["width"] - dx - 1)
    dheight = min(y0 + h0, det["height"]) - dy0 - 1
    solid_graph = f"[0:v]drawbox=x={r['x']}:y={y0}:w={r['width']}:h={h0}:color=black@1:t=fill[vout]"
    delogo_graph = f"[0:v]delogo=x={dx}:y={dy0}:w={dwidth}:h={dheight}[vout]"
    for method, graph in (("solid", solid_graph), ("inpaint", delogo_graph)):
        outm = os.path.join(tmp, f"{method}.mp4")
        res = subprocess.run([FFMPEG, "-y", "-hide_banner", "-v", "error", "-i", audio,
                              "-filter_complex", graph, "-map", "[vout]", "-map", "0:a?",
                              "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
                              "-c:a", "copy", "-pix_fmt", "yuv420p", outm],
                             capture_output=True, timeout=180)
        check(f"remove method renders: {method}", res.returncode == 0,
              res.stderr.decode()[-160:])

    print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
    return 1 if FAIL else 0


if __name__ == "__main__":
    try:
        if "cv" not in sys.modules:
            import cv2  # noqa: F401
    except ImportError:
        print("SKIP: cv2 not installed in this interpreter")
        sys.exit(0)
    sys.exit(main())
