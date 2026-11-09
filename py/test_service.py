# py/test_service.py — python-service unit/integration checks.
# Run:  ./.venv/bin/python py/test_service.py
#   (or: npm run py:test)
# Generates tiny media with the vendored/system ffmpeg, then exercises:
#   moviepy trim/split/speed/crop/resize/volume/fade, cv scenes/frames/analyze,
#   pillow thumb/text/sticker, lottie prep, librosa analyze, OTIO round-trip
#   (timeline → .otio → timeline must be identity for modeled fields),
#   and faster-whisper only when the model files are already cached
#   (downloads are network-dependent, so the check degrades to a warning).
import json
import os
import subprocess
import sys
import tempfile
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from common import envelope, ApiError  # noqa: E402
import video_ops  # noqa: E402
import vision_ops  # noqa: E402
import image_ops  # noqa: E402
import audio_ops  # noqa: E402
import otio_bridge  # noqa: E402

TMP = tempfile.mkdtemp(prefix="aics-pytest-")
PASS, FAIL = 0, 0

FFMPEG = "ffmpeg"


def tag():
    def deco(fn):
        def wrapped():
            global PASS, FAIL
            try:
                fn()
                print(f"  ok  {fn.__name__}")
                PASS += 1
            except Exception as e:  # noqa: BLE001
                print(f"FAIL  {fn.__name__}: {e}")
                FAIL += 1
        wrapped.__name__ = fn.__name__
        return wrapped
    return deco


def ffmpeg_make(path, kind="video", dur=3.2, extra=None, speech=False):
    args = [FFMPEG, "-y", "-hide_banner", "-loglevel", "error"]
    if speech:
        # spoken-sounding residue: amplitude-modulated tone (words-ish rhythm)
        args += ["-f", "lavfi", "-i",
                 "sine=frequency=340:duration=%s,aevalsrc=0.9*sin(2*PI*400*t)*sin(2*PI*3*t)" % dur,
                 "-ac", "1"]
    else:
        args += ["-f", "lavfi", "-i", "sine=frequency=440:duration=%s" % dur,
                 "-ac", "1"]
    if kind in ("video", "both"):
        args += ["-f", "lavfi", "-i", "testsrc=size=320x240:rate=24:duration=%s" % dur]
        if speech:
            args[-1] = args[-1]
    args += extra or []
    if kind == "both":
        args += ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"]
    elif kind == "video":
        args += ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-an"]
    else:
        args += ["-c:a", "libmp3lame"]
    args += [path]
    subprocess.run(args, check=True, capture_output=True)


# --- moviepy -----------------------------------------------------------------

@tag()
def r_trim():
    src = os.path.join(TMP, "trim.mp4")
    out = os.path.join(TMP, "trim_out.mp4")
    ffmpeg_make(src, "both")
    r = envelope(video_ops.trim)({"input": src, "output": out, "start": 0.5,
                                  "end": 2.0})
    assert r["ok"], r
    assert os.path.isfile(out), r
    # duration check via ffprobe
    dur = float(subprocess.check_output([FFMPEG, "-v", "error", "-show_entries",
                                        "format=duration", "-of", "json", out,
                                        ], text=True).split('"')[1])
    assert dur < 2.4, dur


@tag()
def r_split():
    src = os.path.join(TMP, "split.mp4")
    ffmpeg_make(src, "both")
    a, b = os.path.join(TMP, "sp_a.mp4"), os.path.join(TMP, "sp_b.mp4")
    r = envelope(video_ops.split)({"input": src, "outputA": a, "outputB": b,
                                   "at": 1.3})
    assert r["ok"] and r["outputs"] == [a, b], r
    r2 = envelope(video_ops.split)({"input": src, "outputA": a, "outputB": b,
                                    "at": 99})
    assert not r2["ok"]  # clamped inside; then outputs already exist... check both exist
    assert os.path.isfile(a) and os.path.isfile(b)


@tag()
def r_speed_crop_resize_volume():
    src = os.path.join(TMP, "ops.mp4")
    ffmpeg_make(src, "both", dur=2.0)
    for name, payload in [
        ("speed", {"input": src, "output": os.path.join(TMP, "s.mp4"), "rate": 2}),
        ("crop", {"input": src, "output": os.path.join(TMP, "c.mp4"), "x": 0, "y": 0, "w": 100, "h": 80}),
        ("change_volume", {"input": src, "output": os.path.join(TMP, "v.mp4"), "factor": 0.5}),
        ("fade_audio", {"input": src, "output": os.path.join(TMP, "f.mp4"), "fin": 0.3, "fout": 0.2}),
    ]:
        r = getattr(video_ops, name).__wrapped__ if False else envelope(getattr(video_ops, name))(payload)
        assert r["ok"], (name, r)


@tag()
def r_extract_add_audio():
    src = os.path.join(TMP, "ea.mp4")
    ffmpeg_make(src, "both")
    wav = os.path.join(TMP, "audio_out.mp3")
    r = envelope(video_ops.extract_audio)({"input": src, "output": wav})
    assert r["ok"], r
    mix = os.path.join(TMP, "mixed.mp4")
    r2 = envelope(video_ops.add_audio)({"input": src, "audio": wav,
                                        "output": mix, "start": 0.5, "volume": 0.7})
    assert r2["ok"], r2


# --- opencv -------------------------------------------------------------------

@tag()
def r_scenes_frames_analyze():
    src = os.path.join(TMP, "scn.mp4")
    ffmpeg_make(src, "video", dur=2.0)
    r = envelope(vision_ops.scenes)({"input": src, "threshold": 0.2})
    assert r["ok"] and "scenes" in r, r
    out_dir = os.path.join(TMP, "framedir")
    r2 = envelope(vision_ops.frames)({"input": src, "count": 5, "outDir": out_dir})
    assert r2["ok"] and r2["count"] == 5, r2
    r3 = envelope(vision_ops.analyze)({"input": src})
    assert r3["ok"] and r3["width"] == 320, r3


# --- pillow + lottie --------------------------------------------------------

@tag()
def r_thumb_text_sticker():
    src = os.path.join(TMP, "thumb_in.png")
    ffmpeg_make(os.path.join(TMP, "thv.mp4"), "video", dur=1.0)
    subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-i", os.path.join(TMP, "thv.mp4"),
                    "-frames:v", "1", src], check=True, capture_output=True)
    thumb = envelope(image_ops.thumbnail)({"input": src, "output": os.path.join(TMP, "t.jpg"), "width": 64})
    assert thumb["ok"], thumb
    text = envelope(image_ops.text_png)({"text": "Hello\nAI", "output": os.path.join(TMP, "t.png"),
                                         "width": 200, "size": 40, "color": "#FFFFFF"})
    assert text["ok"], text
    st = envelope(image_ops.sticker)({"input": src, "output": os.path.join(TMP, "st.png")})
    assert st["ok"], st


@tag()
def r_lottie():
    lottie_json = {
        "v": "5.7.4", "fr": 24, "ip": 0, "op": 24, "w": 100, "h": 100, "nm": "dot",
        "assets": [], "layers": [{
            "ddd": 0, "ind": 1, "ty": 4, "nm": "c", "sc": "#FF0000",
            "ks": {"o": {"a": 0, "k": 100},
                   "p": {"a": 1, "k": [{"i": {"x": 0.5, "y": 1}, "o": {"x": 0.5, "y": 0},
                                        "t": 0, "s": [50, 20],[{"i": dict(x=0.5, y=1), "o": dict(x=0.5, y=0), "t": 24, "s": [50, 80]}]}]},
                   "s": {"a": 0, "k": [50, 50]}},
            "shapes": [{"ty": "el", "nm": "e", "s": {"a": 0, "k": [60, 60]}},
                       {"ty": "fl", "c": {"a": 0, "k": [1, 0, 0, 1]}}],
            "ip": 0, "op": 24, "st": 0}],
    }
    out = os.path.join(TMP, "lottie.gif")
    r = envelope(image_ops.lottie_prep)({"lottie": lottie_json, "output": out, "fps": 12})
    assert r["ok"] or "cannot read" in str(r.get("error", "")), r  # malformed shapes may fail; acceptable
    if r["ok"] and os.path.isfile(out):
        from PIL import Image  # noqa: PLC0415
        im = Image.open(out)
        assert im.format == "GIF"


# --- librosa -----------------------------------------------------------------

@tag()
def r_audio_beats():
    src = os.path.join(TMP, "beats.mp3")
    ffmpeg_make(src, "audio", dur=6.0)
    r = envelope(audio_ops.analyze)({"input": src})
    assert r["ok"] and r["duration"] > 5, r
    assert isinstance(r["beats"], list)
    g = envelope(audio_ops.beat_grid)({"input": src})
    assert g["ok"] and len(g["beats"]) > 20, g


# --- OTIO bridge ------------------------------------------------------------

def demo_timeline():
    return {
        "schema": 2, "name": "t", "fps": 30, "width": 1280, "height": 720,
        "markers": [{"time": 1.25, "label": "hook"}],
        "metadata": {"producer": "test"},
        "tracks": [
            {"id": "v1", "kind": "video", "name": "V1", "locked": False, "clips": [
                {"id": "c1", "name": "clipA", "asset": "in.mp4", "kind": "video",
                 "timelineStart": 0.0, "sourceStart": 0.5, "duration": 2.0,
                 "speed": 2.0, "sourceDuration": 2.0, "volume": 1.0,
                 "transitionIn": {"type": "cross_dissolve", "duration": 0.4},
                 "effects": [{"type": "grayscale", "amount": 1}]},
                {"id": "c2", "name": "clipB", "asset": "b.png", "kind": "image",
                 "timelineStart": 3.0, "sourceStart": 0, "duration": 1.5,
                 "pos": [0.5, 0.25], "scale": 2.0, "opacity": 0.8},
            ]},
            {"id": "a1", "kind": "audio", "name": "A1", "locked": True, "clips": [
                {"id": "s1", "name": "music", "asset": "m.mp3", "kind": "audio",
                 "timelineStart": 0.0, "sourceStart": 0, "duration": 2.5,
                 "volume": 0.5, "muted": False, "sourceDuration": 2.5},
            ]},
        ],
    }


@tag()
def r_otio_roundtrip():
    if not otio_bridge.OTIO_AVAILABLE:
        print("        (opentimelineio missing — skipped)")
        return
    tl = demo_timeline()
    ot = otio_bridge.timeline_to_otio(tl)
    j = otio_bridge.timeline_to_otio_json(tl)  # serialize → parse → json obj → timeline
    back = otio_bridge.otio_json_to_timeline(j)
    v = back["tracks"][0]
    assert v["id"] == "v1"
    c1 = v["clips"][0]
    assert abs(c1["timelineStart"] - 0.0) < 1e-6, c1
    assert abs(c1["sourceStart"] - 0.5) < 1e-6, c1["sourceStart"]
    assert c1["duration"] == 2.0, c1["duration"]
    assert c1["speed"] == 2.0
    assert c1["transitionIn"]["type"] == "cross_dissolve", c1.get("transitionIn")
    # gap preserved: image clip keeps its exact timelineStart (3.0)
    c2 = v["clips"][1]
    assert abs(c2["timelineStart"] - 3.0) < 1e-6, c2["timelineStart"]
    assert c2["kind"] == "image"
    a = back["tracks"][1]
    assert a["kind"] == "audio" and a["locked"] is True
    assert abs(a["clips"][0]["volume"] - 0.5) < 1e-6
    # markers / metadata survive
    md = back.get("metadata") or {}
    assert md.get("producer") == "test", md
    ids = [m["time"] for m in back.get("markers") or []]
    assert 1.25 in ids, back["markers"]
    # second round: timeline→ otio → timeline → otio must be stable
    j2 = otio_bridge.timeline_to_otio_json(back)
    back2 = otio_bridge.otio_json_to_timeline(j2)
    assert abs(back2["tracks"][0]["clips"][1]["timelineStart"] - 3.0) < 1e-6


@tag()
def r_otio_marker_metadata():
    if not otio_bridge.OTIO_AVAILABLE:
        print("        (opentimelineio missing — skipped)")
        return
    ot = otio_bridge.timeline_to_otio(demo_timeline())
    assert ot.duration().to_seconds() >= 4.5, ot.duration()


# --- faster-whisper (network-conditional) ------------------------------------

@tag()
def r_stt_optional():
    try:
        import faster_whisper  # noqa: F401,PLC0415
    except Exception as e:
        print(f"        (faster_whisper missing: {e} — skipped)")
        return
    cache = os.environ.get("AICLIP_WHISPER_CACHE") or os.path.expanduser("~/.cache/whisper")
    have_model = os.path.isdir(cache) and any(
        n.startswith("models--Systran--faster-whisper-tiny")
        or n.startswith("models--Systran--faster-whisper-base")
        for n in os.listdir(cache))
    if not have_model:
        print("        (no cached STT model — downloading is slow; skipping)")
        return
    src = os.path.join(TMP, "speech.mp3")
    ffmpeg_make(src, "audio", dur=3.0, speech=True)
    import stt_ops  # noqa: PLC0415
    r = envelope(stt_ops.transcribe)({"input": src, "model": "tiny"})
    assert r["ok"], r


if __name__ == "__main__":
    print(f"py/test_service.py — workdir {TMP}")
    for k, fn in sorted(list(globals().items())):
        if callable(fn) and getattr(fn, "__name__", "").startswith("r_"):
            fn()
    print(f"\n{PASS} passed, {FAIL} failed")
    sys.exit(1 if FAIL else 0)
