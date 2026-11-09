# py/stt_ops.py — faster-whisper speech-to-text with segment + word timestamps.
# Model files download on first use (HuggingFace) and are cached in
# $AICLIP_WHISPER_CACHE (default: ~/.cache/whisper). Runs as background jobs:
# model load is slow, so POST /stt/start returns a job id and GET /stt/status
# reports {progress, result}.
import os
import threading
import time
import traceback

from common import ApiError, ModuleGate, envelope, clamp

fw_gate = ModuleGate("faster_whisper")

_MODELS = {}          # name → WhisperModel instance (paused-download-safe)
_JOBS = {}            # id → {status, progress, result, error}
_JOBS_LOCK = threading.Lock()

_MODEL_SIZES = {"tiny", "base", "small", "medium", "large-v3"}


def _model(name):
    fw = fw_gate.get()
    name = name if name in _MODEL_SIZES else "base"
    cache = os.environ.get("AICLIP_WHISPER_CACHE") or os.path.expanduser("~/.cache/whisper")
    os.makedirs(cache, exist_ok=True)
    with _JOBS_LOCK:
        if name not in _MODELS:
            _MODELS[name] = fw.WhisperModel(
                name, device="cpu", compute_type=os.environ.get("AICLIP_STT_COMPUTE") or "int8",
                download_root=cache)
        return _MODELS[name]


@envelope
def transcribe(d):
    """{input, model?, language?} — synchronous transcribe (small clips only)"""
    segments = _run(d)[0]
    return {"segments": segments}


@envelope
def start(d):
    """{input, model?, language?} → {job} — kick off async transcribe."""
    src = d.get("input")
    if not src or not os.path.isfile(src):
        raise ApiError(f"missing audio input: {src}")
    import uuid
    job_id = uuid.uuid4().hex
    with _JOBS_LOCK:
        _JOBS[job_id] = {"status": "running", "progress": 0.0,
                         "result": None, "error": None,
                         "started": time.time()}
    th = threading.Thread(target=_worker, args=(job_id, dict(d)), daemon=True)
    th.start()
    return {"job": job_id}


def _worker(job_id, d):
    try:
        def on_progress(seg_end, total_dur):
            if total_dur:
                with _JOBS_LOCK:
                    j = _JOBS.get(job_id)
                    if j:
                        j["progress"] = min(0.99, max(0.0, seg_end / total_dur))
        segments, info = _run(d, on_progress)
        with _JOBS_LOCK:
            j = _JOBS.get(job_id)
            if j:
                j.update(status="done", progress=1.0, result={
                    "segments": segments,
                    "duration": round(float(info.duration), 3),
                    "language": info.language,
                    "language_probability": round(float(info.language_probability or 0), 3),
                })
    except Exception as e:
        traceback.print_exc()
        with _JOBS_LOCK:
            j = _JOBS.get(job_id)
            if j:
                j.update(status="failed", error=str(e)[:400])


def _run(d, on_progress=None):
    fw = fw_gate.get()
    src = d.get("input")
    if not src or not os.path.isfile(src):
        raise ApiError(f"missing audio input: {src}", 400)
    model = str(d.get("model") or "base")
    if model not in _MODEL_SIZES:
        model = "base"
    lang = d.get("language") or None
    try:
        segments_iter, info = _model(model).transcribe(
            src, language=lang, vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 250})
    except Exception as e:
        raise ApiError(f"transcription failed: {e}", 500)
    segments = []
    total_dur = float(info.duration or 0)
    for seg in segments_iter:
        if on_progress:
            try:
                on_progress(float(seg.end or 0), total_dur)
            except Exception:
                pass
        segment = {"start": round(float(seg.start), 3),
                   "end": round(float(seg.end), 3),
                   "text": (seg.text or "").strip()}
        words = []
        for w in (seg.words or []):
            words.append({"word": w.word, "start": round(float(w.start), 3),
                          "end": round(float(w.end), 3)})
        if words:
            segment["words"] = words
        if segment["text"]:
            segments.append(segment)
    return segments, info


@envelope
def status(d):
    """{job} → {status, progress, result?, error?}"""
    job = d.get("job")
    with _JOBS_LOCK:
        j = _JOBS.get(job)
        if not j:
            raise ApiError(f"unknown STT job: {job}", 404)
        return {"status": j["status"], "progress": j["progress"],
                "result": j["result"], "error": j["error"],
                "age_ms": int((time.time() - j["started"]) * 1000)}


@envelope
def cleanup(d):
    """{older_than_ms?} — drop finished jobs older than this (memory hygiene)."""
    cutoff = time.time() * 1000 - float(clamp(d.get("older_than_ms") or 3.6e6, 0, 1e9))
    with _JOBS_LOCK:
        for k in list(_JOBS):
            j = _JOBS[k]
            if j["status"] in ("done", "failed") and j["started"] * 1000 < cutoff:
                del _JOBS[k]
    return {"ok": True}
