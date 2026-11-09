# py/audio_ops.py — librosa audio analysis: tempo, beat grid, onsets, RMS.
# Analysis only — rendering stays in ffmpeg/moviepy paths.
import os

from common import ApiError, ModuleGate, require, envelope, clamp

lb_gate = ModuleGate("librosa")


@envelope
def analyze(d):
    """{input} — {duration, tempo, beats[], onsets[], rms_mean, too_long?}.
    Loads mono 22.05 kHz; hard caps the analyzed window via LIBROSA_MAX_SECONDS
    (default 300s) so huge uploads can't OOM."""
    librosa = lb_gate.get()
    src = d.get("input")
    if not src or not os.path.isfile(src):
        raise ApiError(f"missing audio input: {src}")
    max_s = clamp(int(os.environ.get("LIBROSA_MAX_SECONDS") or 300), 10, 3600)
    try:
        y, sr = librosa.load(src, sr=None, mono=True, duration=max_s)
    except Exception as e:
        raise ApiError(f"cannot decode audio for analysis: {e}", 500)
    if not len(y):
        raise ApiError("audio is empty")
    # librosa needs numpy too — imported implicitly by librosa itself
    hop = max(64, int(len(y) / 512))
    tempo, _beats = librosa.beat.beat_track(y=y, sr=sr, trim=False)
    onset_env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop)
    beats = librosa.onset.onset_detect(
        onset_envelope=onset_env, sr=sr, hop_length=hop, units="time")
    rms = librosa.feature.rms(y=y, hop_length=hop)
    return {
        "duration": round(float(len(y) / sr), 3),
        "tempo": round(float(tempo[0] if hasattr(tempo, "__len__") else tempo), 2),
        "beats": [round(float(b), 3) for b in beats[:2000]],
        "onsets": [round(float(o), 3) for o in beats[:2000]],
        "rms_mean": round(float(rms.mean()) if rms.size else 0.0, 5),
        "sample_rate": int(sr),
    }


@envelope
def beat_grid(d):
    """{input, bpm_hint?} — evenly spaced beat times from the tempo estimate."""
    librosa = lb_gate.get()
    src = d.get("input")
    res = analyze(d)
    if not res.get("ok", True):
        return res
    tempo = res["tempo"] or 120
    duration = res["duration"]
    if tempo <= 0:
        raise ApiError("tempo estimate failed on this audio")
    step = 60.0 / float(tempo)
    return {"tempo": tempo, "duration": duration,
            "beats": [round(i * step, 3) for i in range(int(duration / step))]}
