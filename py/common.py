# py/common.py — shared helpers for the AIClipStudio Python service.
# Stdlib only here: every module must degrade gracefully when its optional
# dependency (moviepy / cv2 / PIL / librosa / lottie / faster_whisper) is not
# importable, and every endpoint returns a normalized JSON envelope.
import importlib
import json
import os
import time
import traceback


class ApiError(Exception):
    """User-facing error: message is safe to send to the client."""

    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


class ModuleGate:
    """Lazy optional-import wrapper. `gate.get()` raises ApiError(500) with a
    clear message when the package is missing, cached so import cost happens
    at most once per module per process."""

    def __init__(self, *names):
        self._names = names
        self._mod = None
        self._loaded = False

    def get(self):
        if not self._loaded:
            self._loaded = True
            try:
                self._mod = importlib.import_module(self._names[0])
            except Exception as e:  # ImportError and all-or-nothing binary crates
                raise ApiError(
                    f"Python dependency '{self._names[0]}' is not available: {e}. "
                    "Install with: pip3 install -r requirements.txt", 500)
        return self._mod

    def available(self):
        try:
            self.get()
            return True
        except ApiError:
            return False


def require(d, *keys, cast=float, default=None, src="payload"):
    """Fetch and cast payload fields; missing -> default, bad value -> ApiError."""
    out = {}
    for k in keys:
        v = d.get(k, default)
        if v is None:
            out[k] = default
            continue
        try:
            if cast is float:
                out[k] = float(v)
            elif cast is int:
                out[k] = int(float(v))
            else:
                out[k] = v
        except (TypeError, ValueError):
            if default is None:
                raise ApiError(f"field '{k}' must be {cast.__name__}-like in {src}")
            out[k] = default
    return out


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


def safe_out(path, base_dir=None):
    """Validate an output path: absolute, not the input itself, writable dir."""
    if not path or not isinstance(path, str):
        raise ApiError("missing output path")
    path = os.path.abspath(path)
    parent = os.path.dirname(path)
    if not os.path.isdir(parent):
        raise ApiError(f"output directory does not exist: {parent}")
    if base_dir:
        base = os.path.abspath(base_dir)
        if not (path == base or path.startswith(base + os.sep)):
            raise ApiError(f"output must stay inside the job folder: {base}")
    return path


def now_ms():
    return int(time.time() * 1000)


def envelope(fn):
    """Route decorator: catches ApiError/exceptions into a consistent envelope."""
    def wrapped(payload):
        started = time.time()
        try:
            result = fn(payload) or {}
            return {"ok": True, "took_ms": int((time.time() - started) * 1000), **result}
        except ApiError as e:
            return {"ok": False, "error": str(e), "status": e.status}
        except Exception as e:  # unexpected → 500 with concise server log
            traceback.print_exc()
            return {"ok": False, "error": f"internal error: {e}", "status": 500}
    wrapped.__name__ = fn.__name__
    return wrapped


def jdump(obj):
    return json.dumps(obj, ensure_ascii=False, default=str)
