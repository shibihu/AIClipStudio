# py/video_ops.py — MoviePy-based video/audio editing operations.
# Every op reads the SOURCE file and writes a NEW file; the original media is
# never touched. Errors surface as ApiError with short client-safe messages.
from common import ApiError, ModuleGate, require, safe_out, clamp, envelope
import os

moviepy_gate = ModuleGate("moviepy")


def _io(d, need=True):
    src = d.get("input")
    out = safe_out(d.get("output"))
    if need:
        if not src:
            raise ApiError("missing input path")
        if src == out:
            raise ApiError("output must differ from input")
    return src, out


def _open_video(src):
    MoviePyClip = moviepy_gate.get().VideoFileClip
    try:
        return MoviePyClip(src)
    except Exception as e:
        raise ApiError(f"cannot open video: {e}", 500)


def _write(clip, out, fps=None, audio=True, bitrate=None):
    mp = moviepy_gate.get()
    # overflow_x11: rendering uses xvfb-free encoder path; set threads for perf
    try:
        params = {"logger": None, "threads": 2}
        if fps:
            params["fps"] = fps
        if bitrate:
            params["bitrate"] = bitrate
        clip.write_videofile(out, codec="libx264", audio_codec="aac",
                             audio=audio, preset="medium", **params)
    except Exception as e:
        raise ApiError(f"render failed: {e}", 500)


@envelope
def trim(d):
    """{input, output, start, end} — keep [start, end) seconds."""
    moviepy_gate.get()
    src, out = _io(d)
    fs = require(d, "start", "end", cast=float, src="trim payload")
    start = clamp(fs["start"] or 0.0, 0.0, 1e9)
    end = fs["end"]
    with _open_video(src) as clip:
        dur = clip.duration
        end = clamp(end if end is not None else dur, start + 0.05, dur)
        if start >= end - 0.04:
            raise ApiError(f"trim range too small ({start:g}..{end:g}s of {dur:g}s)")
        piece = clip.subclipped(start, end)
        try:
            _write(piece, out, fps=clip.fps)
        finally:
            piece.close()
    return {"output": out, "start": start, "end": end}


@envelope
def split(d):
    """{input, outputA, outputB, at} — split at a time point."""
    moviepy_gate.get()
    src = d.get("input")
    if not src:
        raise ApiError("missing input path")
    outA = safe_out(d.get("outputA") or d.get("output1"))
    outB = safe_out(d.get("outputB") or d.get("output2"))
    at = clamp(require(d, "at", cast=float, default=0.0)["at"] or 0.0, 0.0, 1e9)
    if src == outA or src == outB or outA == outB:
        raise ApiError("split outputs must differ from each other and input")
    if not os.path.isfile(src):
        raise ApiError(f"missing input file: {src}")
    with _open_video(src) as clip:
        dur = clip.duration
        at = clamp(at, 0.05, dur - 0.05)
        if dur < 0.2:
            raise ApiError(f"clip too short to split ({dur:g}s)")
        a = clip.subclipped(0, at)
        b = clip.subclipped(at, dur)
        try:
            _write(a, outA, fps=clip.fps)
            _write(b, outB, fps=clip.fps)
        finally:
            a.close()
            b.close()
    return {"outputs": [outA, outB], "at": at}


@envelope
def speed(d):
    """{input, output, rate} — rate>1 faster, rate<1 slower."""
    mp = moviepy_gate.get()
    src, out = _io(d)
    rate = clamp(require(d, "rate", cast=float, default=1.0)["rate"] or 1.0, 0.1, 8.0)
    if rate == 1.0:
        d2 = dict(d, output=out)
        return trim(d2)
    with _open_video(src) as clip:
        v = clip.with_speed_scaled(rate) if hasattr(clip, "with_speed_scaled") \
            else clip.speedx(rate)
        try:
            _write(v, out, fps=clip.fps)
        finally:
            v.close()
    return {"output": out, "rate": rate}


@envelope
def crop(d):
    """{input, output, x, y, w, h} — integer pixel crop box (clamped)."""
    mp = moviepy_gate.get()
    src, out = _io(d)
    box = require(d, "x", "y", "w", "h", cast=int, src="crop payload")
    with _open_video(src) as clip:
        w, h = clip.size
        x = clamp(box["x"] or 0, 0, max(0, w - 2))
        y = clamp(box["y"] or 0, 0, max(0, h - 2))
        cw = clamp(box["w"] or w, 2, w - x)
        ch = clamp(box["h"] or h, 2, h - y)
        if cw * ch >= w * h:
            raise ApiError(f"crop box {cw}x{ch} equals the frame {w}x{h}; nothing to do")
        cropped = clip.cropped(x1=x, y1=y, x2=x + cw, y2=y + ch)
        try:
            _write(cropped, out, fps=clip.fps)
        finally:
            cropped.close()
    return {"output": out, "x": x, "y": y, "w": cw, "h": ch}


@envelope
def resize(d):
    """{input, output, width?, height?} — one of both; aspect kept."""
    moviepy_gate.get()
    src, out = _io(d)
    want = require(d, "width", "height", cast=int, src="resize payload")
    with _open_video(src) as clip:
        w, h = clip.size
        tw = want["width"]
        th = want["height"]
        if tw and th:
            raise ApiError("give width OR height, not both (aspect is preserved)")
        if not tw and not th:
            raise ApiError("need width or height")
        scale = (tw / w) if tw else (th / h)
        scale = clamp(scale, 0.05, 4.0)
        if abs(scale - 1.0) < 1e-3:
            raise ApiError("requested size equals the current size")
        new = (int(round(w * scale)) // 2 * 2, int(round(h * scale)) // 2 * 2)
        scaled = clip.resized(new_size=new)
        try:
            _write(scaled, out, fps=clip.fps)
        finally:
            scaled.close()
    return {"output": out, "width": new[0], "height": new[1]}


@envelope
def extract_audio(d):
    """{input, output} — dump the audio track as a standalone file (mp3/wav)."""
    moviepy_gate.get()
    src, out = _io(d)
    with _open_video(src) as clip:
        if clip.audio is None:
            raise ApiError("source has no audio track")
        try:
            clip.audio.write_audiofile(out, logger=None)
        except Exception as e:
            raise ApiError(f"audio export failed: {e}", 500)
    return {"output": out}


@envelope
def add_audio(d):
    """{input(video), audio, output, start?, volume?} — lay audio over the video
    starting at `start` seconds; the original video audio keeps playing."""
    mp = moviepy_gate.get()
    src, out = _io(d)
    audio_src = d.get("audio")
    if not audio_src or audio_src == out:
        raise ApiError("need an 'audio' path distinct from output")
    start = clamp(require(d, "start", cast=float, default=0.0)["start"] or 0.0, 0.0, 1e9)
    volume = clamp(require(d, "volume", cast=float, default=1.0)["volume"] or 1.0, 0.0, 4.0)
    from moviepy import CompositeAudioClip, AudioFileClip
    over = AudioFileClip(audio_src)
    try:
        if volume != 1.0:
            over = over.with_effects([mp.afx.MultiplyVolume(volume)])
        over = over.with_start(start)
        with _open_video(src) as clip:
            final_audio = CompositeAudioClip([clip.audio, over]) \
                if clip.audio is not None else CompositeAudioClip([over])
            out_clip = clip.with_audio(final_audio)
            try:
                _write(out_clip, out, fps=clip.fps)
            finally:
                out_clip.close()
    finally:
        _close(over)
    return {"output": out, "start": start, "volume": volume}


@envelope
def fade_audio(d):
    """{input, output, in?, out?} — add fade-in / fade-out on the clip audio."""
    mp = moviepy_gate.get()
    src, out = _io(d)
    fade_in = clamp(require(d, "fin", cast=float, default=0.5)["fin"] or 0.5, 0.0, 30.0)
    fade_out = clamp(require(d, "fout", cast=float, default=0.5)["fout"] or 0.5, 0.0, 30.0)
    with _open_video(src) as clip:
        if clip.audio is None:
            raise ApiError("clip has no audio to fade")
        afx = mp.afx
        seg = clip.audio.with_effects([
            afx.AudioFadeIn(fade_in),
            afx.AudioFadeOut(fade_out),
        ])
        out_clip = clip.with_audio(seg)
        try:
            _write(out_clip, out, fps=clip.fps)
        finally:
            out_clip.close()
    return {"output": out, "fade_in": fade_in, "fade_out": fade_out}


@envelope
def change_volume(d):
    """{input, output, factor} — multiply audio volume in place of none."""
    mp = moviepy_gate.get()
    src, out = _io(d)
    factor = clamp(require(d, "factor", cast=float, default=1.0)["factor"] or 1.0, 0.0, 8.0)
    if factor == 1.0:
        raise ApiError("volume factor 1.0 changes nothing; pick >1 or <1")
    with _open_video(src) as clip:
        if clip.audio is None:
            raise ApiError("clip has no audio track")
        audible = clip.audio.with_effects([mp.afx.MultiplyVolume(factor)])
        out_clip = clip.with_audio(audible)
        try:
            _write(out_clip, out, fps=clip.fps)
        finally:
            out_clip.close()
    return {"output": out, "factor": factor}


@envelope
def concat(d):
    """{inputs[], output} — sequential join of clips/audios (same shape)."""
    mp = moviepy_gate.get()
    inputs = d.get("inputs") or []
    out = safe_out(d.get("output"))
    if len(inputs) < 1:
        raise ApiError("concat needs at least one input")
    clips = []
    try:
        for src in inputs:
            clips.append(_open_video(src))
        if len(clips) == 1:
            clips[0].write_videofile(out, codec="libx264", audio_codec="aac",
                                     logger=None, threads=2)
        else:
            from moviepy import concatenate_videoclips
            joined = concatenate_videoclips(clips, method="compose")
            try:
                _write(joined, out, fps=clips[0].fps)
            finally:
                joined.close()
    finally:
        for c in clips:
            _close(c)
    return {"output": out, "count": len(inputs)}


def _close(c):
    try:
        c.close()
    except Exception:
        pass


# ---------------------------------------------------------------------------
# render_timeline — general multi-track materialization of the AIClipStudio
# internal timeline (JSON from timeline.summarize()) using MoviePy layers:
#   • video track 1…n: clips trimmed (subclipped) and speed-rescaled
#   • image/text overlays: ImageClips with alpha, positioned by pos/scale
#   • transitions: FadeIn approximation (dip_to_color) / CrossFadeIn softening
#   • audio tracks: trimmed + mixed via CompositeAudioClip
# Only a single base video track is fully supported for compositing positions
# today; extra video tracks composite over layer order top-down. Original
# media on disk is never touched — every render writes ONE new file.
# ---------------------------------------------------------------------------

@envelope
def render_timeline(d):
    mp = moviepy_gate.get()
    from moviepy import (VideoFileClip, AudioFileClip, ImageClip,
                         CompositeVideoClip, CompositeAudioClip, concatenate_videoclips)
    import os as _os
    tl = d.get("timeline") or {}
    out = safe_out(d.get("output"))
    base_dir = (d.get("dir") or "").rstrip("/") or None
    fps = float(tl.get("fps") or 30)
    W = int(tl.get("width") or 0) or None
    H = int(tl.get("height") or 0) or None

    def resolve(asset):
        apath = asset[7:] if asset.startswith("text:") else asset
        if base_dir and not _os.path.isabs(apath):
            apath = _os.path.join(base_dir, apath)
        return apath

    clips_by_track = []
    audio_streams = []
    overlays = []
    for tr in tl.get("tracks", []):
        for c in tr.get("clips", []):
            dur = clamp(float(c.get("duration") or 0), 0.05, 1e5)
            start = clamp(float(c.get("timelineStart") or 0), 0, 1e5)
            asset = str(c.get("asset") or "")
            vol = clamp(float(c.get("volume") if c.get("volume") is not None else 1), 0, 4)
            spd = clamp(float(c.get("speed") or 1), 0.1, 8)

            def load(av=asset, k=c.get("kind") or "video"):
                if k == "video":
                    v = VideoFileClip(resolve(av))
                    return v
                if k == "audio":
                    a = AudioFileClip(resolve(av))
                    return a
                return None  # image/overlay handled separately

            if (c.get("kind") or "video") == "audio":
                a = load()
                a = a.subclipped(clamp(float(c.get("sourceStart") or 0), 0, a.duration), None)
                if spd != 1:
                    a = a.with_speed_scaled(spd)
                a = a.subclipped(0, dur) if a.duration > dur else a
                if vol != 1:
                    a = a.with_effects([mp.afx.MultiplyVolume(vol)])
                if c.get("muted"):
                    continue
                audio_streams.append(a.with_start(start))
                continue

            if (c.get("kind")) == "image":
                img_src = resolve(asset)
                if img_src.startswith("text:"):
                    raise ApiError("text: asset references need pillow text rendering first; "
                                   "ask the Node layer to convert text overlays to PNG")
                try:
                    img = ImageClip(img_src)
                except Exception as e:
                    raise ApiError(f"cannot load overlay image: {e}", 500)
                img = img.with_duration(dur).with_start(start)
                if W and H:
                    iw, ih = img.size
                    want_w = int(iw * clamp(float(c.get("scale") or 1), 0.01, 10))
                    img = img.resized(width=want_w) if iw else img
                    ov = c.get("pos") or [0.5, 0.5]
                    img = img.with_position(
                        (clamp(ov[0], -0.4, 1.4) * max(1, W - img.w),
                         clamp(ov[1], -0.4, 1.4) * max(1, H - img.h)))
                op = float(c.get("opacity") if c.get("opacity") is not None else 1)
                if op < 1:
                    img = img.with_effects([mp.vfx.MultiplyOpacity(op)]) \
                        if hasattr(mp.vfx, "MultiplyOpacity") else img.with_opacity(op)
                tr_in = c.get("transitionIn")
                if tr_in and tr_in.get("type") in ("dip_to_color", "cross_dissolve"):
                    fin = clamp(float(tr_in.get("duration") or 0.3), 0.05, dur / 2)
                    img = img.with_effects([mp.vfx.FadeIn(fin)])
                overlays.append(img)
                continue

            # ---- video clip ----
            piece = load()
            try:
                src_start = clamp(float(c.get("sourceStart") or 0), 0, piece.duration or 0)
                piece = piece.subclipped(src_start, None)
                if spd != 1:
                    piece = piece.with_speed_scaled(spd)
                if piece.duration > dur:
                    piece = piece.subclipped(0, dur)
                tr_in = c.get("transitionIn")
                if tr_in and tr_in.get("type") in ("dip_to_color", "cross_dissolve"):
                    fin = clamp(float(tr_in.get("duration") or 0.3), 0.05, max(0.05, dur / 2))
                    piece = piece.with_effects([mp.vfx.CrossFadeIn(fin)])
                clips_by_track.append((tr.get("id"), c, piece, start, dur))
            except Exception as e:
                _close(piece)
                raise ApiError(f"cannot assemble clip: {e}", 500)

    if not clips_by_track and not audio_streams and not overlays:
        raise ApiError("timeline has no usable clips")

    video_layers = []
    if clips_by_track:
        vids = [(i[2], i[3]) for i in clips_by_track]
        if len(vids) == 1:
            v, st = vids[0]
            v = v.with_start(st) if st > 0 else v
            video_layers.append(v)
        else:
            for v, st in vids:
                video_layers.append(v.with_start(st) if st > 0 else v)
    if not video_layers and not overlays:
        raise ApiError("timeline has no visual clips; nothing to render")

    master = None
    stop_watch = [0.0]
    if video_layers and overlays:
        comp = CompositeVideoClip([*video_layers, *overlays], size=(W, H) if W and H else None)
    elif video_layers and W and H:
        comp = CompositeVideoClip(video_layers, size=(W, H))
    elif video_layers:
        comp = CompositeVideoClip(video_layers)
    else:
        comp = None
    try:
        if audio_streams and comp is not None:
            comp = comp.with_audio(CompositeAudioClip(audio_streams))
        elif audio_streams:
            raise ApiError("audio-only timeline rendering needs at least one visual clip")
        if comp is not None:
            try:
                _write(comp, out, fps=fps or 30)
            finally:
                comp.close()
    finally:
        for c, _c, piece, _s, _d in clips_by_track:
            _close(piece)
        for a in audio_streams:
            _close(a)
        for o in overlays:
            _close(o)
    return {"output": out}
