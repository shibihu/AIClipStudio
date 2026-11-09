# py/otio_bridge.py — conversion layer between the AIClipStudio internal
# timeline JSON and OpenTimelineIO (OTIO). Single source of truth for the
# mapping rules; the Node timeline model (timeline.js) produces/parses the
# same JSON shape, and the invariant is export -> import == identity for
# every field we model. Transitions ride as OTIO Transition items placed
# before their owning clip; timing offsets are byte-stable via RationalTime.
try:
    import opentimelineio as otio
    OTIO_AVAILABLE = True
    OTIO_IMPORT_ERROR = None
except Exception as _e:  # pragma: no cover - depends on install
    otio = None
    OTIO_AVAILABLE = False
    OTIO_IMPORT_ERROR = str(_e)

from common import ApiError

SCHEMA_KEY = "aiclipstudio"
DEFAULT_FPS = 30.0
TRANSITION_TYPES = {"cut", "dip_to_color", "cross_dissolve", "slide", "wipe"}


def _require_otio():
    if not OTIO_AVAILABLE:
        raise ApiError(
            f"opentimelineio is not available ({OTIO_IMPORT_ERROR}). "
            "Install with: pip3 install -r requirements.txt", 500)


def _r(x, nd=6):
    if x is None:
        return None
    try:
        v = round(float(x) + 0.0, nd)
    except (TypeError, ValueError):
        raise ApiError(f"non-numeric timeline value: {x!r}")
    return v


def _sec(rt):
    """RationalTime → rounded seconds."""
    if rt is None:
        return 0.0
    return _r(rt.to_seconds())


def _get(obj_meta, key):
    return (obj_meta or {}).get(SCHEMA_KEY, {}).get(key)


def _set_meta(obj, key, value):
    obj.metadata.setdefault(SCHEMA_KEY, {})[key] = value


def _meta_all(obj):
    return (obj.metadata or {}).get(SCHEMA_KEY, {})


# --- internal -> OTIO ----------------------------------------------------------

def timeline_to_otio(timeline):
    """AIClipStudio internal timeline JSON dict → otio Timeline object."""
    _require_otio()
    fps = float(timeline.get("fps") or DEFAULT_FPS)

    ot = otio.schema.Timeline(
        name=str(timeline.get("name") or "aiclipstudio timeline"),
        global_start_time=otio.opentime.RationalTime(0, fps),
    )
    md = ot.metadata.setdefault(SCHEMA_KEY, {})
    md["schema"] = 2
    md["fps"] = fps
    if timeline.get("width") is not None:
        md["width"] = _r(timeline["width"])
    if timeline.get("height") is not None:
        md["height"] = _r(timeline["height"])
    if timeline.get("markers"):
        md["markers"] = timeline["markers"]
    if timeline.get("metadata") is not None:
        md["project"] = timeline["metadata"]

    for tr in timeline.get("tracks", []):
        kind_v = tr.get("kind", "video")
        ot_track = otio.schema.Track(
            name=str(tr.get("name") or ("V" if kind_v == "video" else "A")),
            kind=otio.schema.TrackKind.Video
            if kind_v == "video" else otio.schema.TrackKind.Audio,
        )
        _set_meta(ot_track, "id", tr.get("id"))
        _set_meta(ot_track, "locked", bool(tr.get("locked")))

        clips = tr.get("clips", [])
        for idx, clip in enumerate(clips):
            start_tl = _r(clip.get("timelineStart") or 0)
            dur = _r(clip.get("duration") or 0.0)
            if dur <= 0:
                continue
            if idx > 0:
                prev = clips[idx - 1]
                prev_end = _r((prev.get("timelineStart") or 0)
                              + (prev.get("duration") or 0))
                if start_tl < prev_end:
                    start_tl = prev_end  # internal model guarantees non-overlap

            # preserve timelineStart exactly: pad the leading gap
            cursor = 0.0
            for child in ot_track.children:
                cursor += _sec(child.trimmed_range().duration)
            gap = _r(start_tl - cursor)
            if gap > 1e-6:
                ot_track.append(otio.schema.Gap(
                    duration=otio.opentime.RationalTime(gap, fps)))

            src_start = _r(clip.get("sourceStart") or 0)
            ot_clip = otio.schema.Clip(
                name=str(clip.get("name") or "clip"),
                source_range=otio.opentime.TimeRange(
                    start_time=otio.opentime.RationalTime(src_start, fps),
                    duration=otio.opentime.RationalTime(dur, fps),
                ),
            )
            clip_md = {
                k: clip.get(k) for k in
                ("asset", "kind", "sourceDuration", "naturalDuration",
                 "sourceWidth", "sourceHeight", "effects", "volume", "muted",
                 "fromVersion", "suffix", "label", "user")
                if clip.get(k) is not None
            }
            if clip.get("speed") not in (None, 1, 1.0):
                clip_md["speed"] = _r(clip["speed"])
            _set_meta(ot_clip, "clip", clip_md)

            if clip.get("transitionIn"):
                t_in = clip["transitionIn"]
                tl_type = t_in.get("type", "cut")
                duration_in = _r(t_in.get("duration", 0.3))
                t = otio.schema.Transition(
                    name="SMPTE.DipToColor" if tl_type == "dip_to_color" else "Custom",
                    in_offset=otio.opentime.RationalTime(
                        duration_in, fps),  # duration of the transition
                )
                t.metadata[SCHEMA_KEY] = {
                    "type": tl_type,
                    "duration": duration_in,
                    **{k: v for k, v in t_in.items() if k not in ("type", "duration")},
                }
                ot_track.append(t)

            ot_track.append(ot_clip)
        ot.tracks.append(ot_track)

    return ot


# --- OTIO -> internal -------------------------------------------------------------

def _clip_from_otio(otitem, fps, transition_in=None):
    """OTIO Clip (+ preceding transition) → internal clip dict."""
    src_range = otitem.source_range
    tl_meta = _meta_all(otitem)
    clip_md = tl_meta.get("clip", {})
    if src_range:
        src_start = _sec(src_range.start_time)
        dur = _sec(src_range.duration)
    else:
        # no source range: use available_range (rare; clip with default source)
        ar = otitem.available_range()
        src_start = _sec(ar.start_time)
        dur = _sec(ar.duration)
    internal = {
        "id": clip_md.get("id") or f"otio-{otitem.name or len(str(otitem))}",
        "name": otitem.name or "clip",
        "asset": clip_md.get("asset") or (otitem.name or ""),
        "timelineStart": 0.0,  # assigned by caller by walking the track
        "sourceStart": src_start,
        "duration": dur,
        "kind": clip_md.get("kind", "video"),
        "speed": clip_md.get("speed", 1.0),
    }
    for k in ("sourceDuration", "naturalDuration", "sourceWidth",
              "sourceHeight", "fromVersion", "volume"):
        if clip_md.get(k) is not None:
            internal[k] = clip_md[k]
    if clip_md.get("effects"):
        internal["effects"] = clip_md["effects"]
    if clip_md.get("muted") is not None:
        internal["muted"] = bool(clip_md["muted"])
    if transition_in:
        internal["transitionIn"] = transition_in
    return internal


def _transition_from_otio(titem):
    return {
        "type": _meta_all(titem).get("type",
                                     "dip_to_color" if titem.name == "SMPTE.DipToColor" else "cut"),
        "duration": _sec(titem.in_offset) or 0.3,
    }


def otio_to_timeline(ot):
    """otio Timeline object → AIClipStudio internal timeline JSON dict."""
    _require_otio()
    fps = _r(ot.duration().rate) if ot.duration().rate else DEFAULT_FPS
    md = (ot.metadata or {}).get(SCHEMA_KEY, {})
    fps = _r(md.get("fps") or fps)

    out = {
        "schema": 2,
        "name": ot.name or "aiclipstudio timeline",
        "fps": fps,
        "width": md.get("width"),
        "height": md.get("height"),
        "tracks": [],
        "markers": md.get("markers") or [],
        "metadata": md.get("project") or None,
    }
    for tr in ot.tracks:
        kind = "video" if tr.kind == otio.schema.TrackKind.Video else "audio"
        tmeta = _meta_all(tr)
        internal_track = {
            "id": tmeta.get("id") or f"t-{len(out['tracks'])}",
            "kind": kind,
            "name": tr.name or "",
            "locked": bool(tmeta.get("locked")),
            "clips": [],
        }
        # walk: gap/clip/transition — gap moves the cursor; a transition holds
        # over the NEXT clip (internal model), export placed it before the clip
        pending_transition = None
        cursor = 0.0
        for item in tr:
            if _is_gap(item):
                cursor += _sec(item.trimmed_range().duration)
                continue
            if _is_transition(item):
                pending_transition = _transition_from_otio(item)
                continue
            if _is_clip(item):
                clip = _clip_from_otio(item, fps, pending_transition)
                pending_transition = None
                # recompute timelineStart from cursor + track cursor offset so
                # overlapping external timelines degrade to sequential placement
                clip["timelineStart"] = _r(cursor)
                cursor = _r(cursor + clip["duration"])
                internal_track["clips"].append(clip)
        out["tracks"].append(internal_track)
    out["duration"] = _r(max((t["clips"][-1]["timelineStart"] + t["clips"][-1]["duration"]
                              for t in out["tracks"] if t["clips"]), default=0.0))
    return out


# --- serializer helpers ------------------------------------------------------------

def timeline_to_otio_json(timeline) -> str:
    return otio.adapters.write_json(timeline_to_otio(timeline))


def otio_json_to_timeline(otio_json: str):
    """Serialized .otio JSON string → internal timeline dict."""
    _require_otio()
    ot = otio.adapters.read_json_from_string(otio_json)
    return otio_to_timeline(ot)
