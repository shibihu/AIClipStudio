# py/service.py — AIClipStudio Python processing service.
# Stdlib HTTP server (no framework) exposing every capability as a JSON
# endpoint. Started automatically by server.js on 127.0.0.1:$PY_SERVICE_PORT.
# Every module degrades independently: a missing dependency yields
# {"ok":false,"error":...} with a clear message, and /health reports exactly
# what works so the Node side can show/hide features.
import errno
import hashlib
import json
import os
import signal
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from common import ApiError, envelope, jdump  # noqa: E402
import video_ops  # noqa: E402
import vision_ops  # noqa: E402
import image_ops  # noqa: E402
import audio_ops  # noqa: E402
import stt_ops  # noqa: E402
import caption_ops  # noqa: E402
import otio_bridge  # noqa: E402

HOST = os.environ.get("PY_SERVICE_HOST") or "127.0.0.1"
PORT = int(os.environ.get("PY_SERVICE_PORT") or 8611)
MAX_BODY = int(os.environ.get("PY_SERVICE_MAX_BODY") or 32 * 1024 * 1024)

# ---- service identity + single-instance bookkeeping ------------------------
# Node's py/service_lifecycle.js verifies identity.install_id before reusing an
# already-running service. Keep this hash byte-for-byte compatible with
# installIdForRoot() there. ROOT is the repository root, not py/.
SERVICE_NAME = "aiclipstudio-py"
SERVICE_PROTOCOL = 2
SERVICE_VERSION = 2
ROOT = os.path.realpath(
    os.environ.get("AICLIP_ROOT")
    or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
)
INSTALL_ID = hashlib.sha256(
    (ROOT + "|aiclipstudio-py|2").encode("utf-8")
).hexdigest()[:24]
INSTANCE_ID = os.environ.get("AICLIP_INSTANCE_ID") or None
STARTED_AT = time.time()
STARTED_AT_ISO = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(STARTED_AT))
RUNTIME_DIR = os.environ.get("AICLIP_RUNTIME_DIR") or os.path.join(ROOT, ".runtime")
LOCK_PATH = os.path.join(RUNTIME_DIR, "py-service.lock")


def service_identity():
    """Identity payload consumed by the Node lifecycle manager."""
    return {
        "service": SERVICE_NAME,
        "protocol": SERVICE_PROTOCOL,
        "version": SERVICE_VERSION,
        "pid": os.getpid(),
        "py_pid": os.getpid(),
        "root": ROOT,
        "install_id": INSTALL_ID,
        "instance_id": INSTANCE_ID,
        "host": HOST,
        "port": PORT,
        "started_at": STARTED_AT,
        "started_at_iso": STARTED_AT_ISO,
        "python": sys.version.split()[0],
    }


# ---- timeline (OTIO bridge only; the internal timeline model lives in Node) ---
@envelope
def timeline_to_otio(payload):
    if not otio_bridge.OTIO_AVAILABLE:
        raise ApiError(f"opentimelineio unavailable: {otio_bridge.OTIO_IMPORT_ERROR}", 500)
    return {"otio": otio_bridge.timeline_to_otio_json(payload.get("timeline") or {})}


@envelope
def timeline_from_otio(payload):
    if not otio_bridge.OTIO_AVAILABLE:
        raise ApiError(f"opentimelineio unavailable: {otio_bridge.OTIO_IMPORT_ERROR}", 500)
    doc = payload.get("otio")
    if not doc:
        raise ApiError("need otio JSON string under 'otio'")
    if not isinstance(doc, str):
        import json as _json
        doc = _json.dumps(doc)  # accept pre-parsed JSON too
    return {"timeline": otio_bridge.otio_json_to_timeline(doc)}


def health_check(_payload):
    mods = {}
    for name, gate in [("moviepy", video_ops.moviepy_gate),
                       ("cv2", vision_ops.cv_gate),
                       ("PIL", image_ops.pil_gate),
                       ("lottie", image_ops.lottie_gate),
                       ("librosa", audio_ops.lb_gate),
                        ("faster_whisper", stt_ops.fw_gate)]:
        try:
            mods[name] = {"available": gate.available(), "version": _ver(name)}
        except Exception as e:  # pragma: no cover
            mods[name] = {"available": False, "error": str(e)[:160]}
    mods["opentimelineio"] = {
        "available": otio_bridge.OTIO_AVAILABLE,
        "error": otio_bridge.OTIO_IMPORT_ERROR,
        "version": _ver("opentimelineio") if otio_bridge.OTIO_AVAILABLE else None,
    }
    # OCR refine for caption detection is optional — report honestly
    mods["rapidocr"] = {"available": caption_ops._ocr() is not None,
                        "version": _ver("rapidocr_onnxruntime")}
    return {"service": SERVICE_NAME, "version": SERVICE_VERSION,
            "protocol": SERVICE_PROTOCOL, "modules": mods,
            "endpoints": sorted(ENDPOINTS),
            "identity": service_identity()}


def _ver(name):
    try:
        import importlib
        m = importlib.import_module(name if name != "PIL" else "PIL")
        return getattr(m, "__version__", None)
    except Exception:
        return None


ENDPOINTS = {
    # health / introspection
    "health": health_check,
    # timeline (OpenTimelineIO)
    "timeline/to_otio": timeline_to_otio,
    "timeline/from_otio": timeline_from_otio,
    # moviepy engine
    "video/trim": video_ops.trim,
    "video/split": video_ops.split,
    "video/speed": video_ops.speed,
    "video/crop": video_ops.crop,
    "video/resize": video_ops.resize,
    "video/extract_audio": video_ops.extract_audio,
    "video/add_audio": video_ops.add_audio,
    "video/fade_audio": video_ops.fade_audio,
    "video/change_volume": video_ops.change_volume,
    "video/concat": video_ops.concat,
    "video/render_timeline": video_ops.render_timeline,
    # OpenCV engine
    "cv/scenes": vision_ops.scenes,
    "cv/frames": vision_ops.frames,
    "cv/analyze": vision_ops.analyze,
    # Pillow + Lottie engine
    "img/thumbnail": image_ops.thumbnail,
    "img/text": image_ops.text_png,
    "img/sticker": image_ops.sticker,
    "lottie/prep": image_ops.lottie_prep,
    # librosa engine
    "audio/analyze": audio_ops.analyze,
    "audio/beat_grid": audio_ops.beat_grid,
    # faster-whisper engine
    "stt/transcribe": stt_ops.transcribe,
    "stt/start": stt_ops.start,
    "stt/status": stt_ops.status,
    "stt/cleanup": stt_ops.cleanup,
    # caption removal engine (detection + region removal + validation)
    "captions/detect": caption_ops.detect,
    "captions/remove_preview": caption_ops.remove_preview,
    "captions/validate": caption_ops.validate,
}





class Handler(BaseHTTPRequestHandler):
    server_version = "AIClipStudioPy/1"

    def log_message(self, fmt, *args):
        code = args[0] if args else None
        if isinstance(code, int) and code >= 400:
            sys.stderr.write("py-service: " + fmt % args + "\n")

    def do_GET(self):
        if urlparse(self.path).path.rstrip("/") in ("/health", "/"):
            res = health_check({})
            self._json(200, res)
        else:
            self._json(404, {"ok": False, "error": "unknown route — POST /<endpoint>"})

    def do_POST(self):
        ep = urlparse(self.path).path.strip("/")
        fn = ENDPOINTS.get(ep)
        if not fn:
            self._json(404, {"ok": False, "error": f"unknown endpoint '{ep}'"})
            return
        try:
            length = int(self.headers.get("content-length") or 0)
        except ValueError:
            length = 0
        if length > MAX_BODY:
            self._json(413, {"ok": False, "error": f"body exceeds {MAX_BODY} bytes"})
            return
        try:
            raw = self.rfile.read(length) if length else b"{}"
            import json as _json
            payload = _json.loads(raw or b"{}")
        except Exception as e:
            self._json(400, {"ok": False, "error": f"invalid JSON body: {e}"})
            return
        res = fn(payload)
        code = 200 if res.get("ok", False) else int(res.get("status") or 500)
        self._json(code, res)

    def _json(self, code, obj, _unused=None):
        try:
            body = jdump(obj).encode("utf-8")
            self.send_response(code)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass


class ServiceHTTPServer(ThreadingHTTPServer):
    """Threaded server with clean, fast shutdown semantics."""
    daemon_threads = True
    allow_reuse_address = True


_srv = None
_shutdown_lock = threading.Lock()
_shutdown_started = False
_signal_count = 0


def _read_lock_info(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            info = json.load(f)
        return info if isinstance(info, dict) else None
    except Exception:
        return None


def _pid_alive(pid):
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return False
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except OSError:
        return False


def _pid_owns_service(pid):
    """True only when /proc/<pid>/cmdline still points at this service.py.

    On systems without /proc this falls back to a live-PID check, which is only
    used to avoid deleting a possibly-live lock — never to kill anything.
    """
    try:
        with open(f"/proc/{int(pid)}/cmdline", "rb") as f:
            parts = [p.decode("utf-8", "replace") for p in f.read().split(b"\0") if p]
    except Exception:
        return _pid_alive(pid)
    if not parts:
        return False
    try:
        cwd = os.readlink(f"/proc/{int(pid)}/cwd")
    except Exception:
        cwd = None
    target = os.path.realpath(os.path.abspath(__file__))
    for part in parts:
        candidate = part if os.path.isabs(part) else os.path.join(cwd or ROOT, part)
        try:
            if os.path.realpath(candidate) == target:
                return True
        except Exception:
            continue
    return False


def acquire_instance_lock():
    """Prevent duplicate python services for this installation.

    Returns (fd, info) for the owner, or (None, info) when another live service
    already owns the lock. Stale locks are removed only after the recorded PID
    is proven dead or proven to be a different program.
    """
    os.makedirs(RUNTIME_DIR, exist_ok=True, mode=0o700)
    for _ in range(40):
        try:
            fd = os.open(LOCK_PATH, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            existing = _read_lock_info(LOCK_PATH)
            if existing and existing.get("service") == SERVICE_NAME \
                    and existing.get("install_id") == INSTALL_ID \
                    and _pid_alive(existing.get("pid")) \
                    and _pid_owns_service(existing.get("pid")):
                return None, existing
            try:
                st = os.stat(LOCK_PATH)
                again = _read_lock_info(LOCK_PATH)
                if again != existing and again is not None:
                    time.sleep(0.05)
                    continue
                # A fresh, unreadable lock may still be mid-write.
                if not existing and (time.time() - st.st_mtime) < 1.0:
                    time.sleep(0.1)
                    continue
                os.unlink(LOCK_PATH)
            except FileNotFoundError:
                pass
            except OSError:
                time.sleep(0.05)
            continue
        info = {
            "service": SERVICE_NAME,
            "protocol": SERVICE_PROTOCOL,
            "version": SERVICE_VERSION,
            "install_id": INSTALL_ID,
            "instance_id": INSTANCE_ID,
            "pid": os.getpid(),
            "port": PORT,
            "host": HOST,
            "root": ROOT,
            "started_at": STARTED_AT_ISO,
        }
        try:
            os.write(fd, (json.dumps(info) + "\n").encode("utf-8"))
            os.fsync(fd)
        except OSError:
            os.close(fd)
            raise
        return fd, info
    raise RuntimeError(f"could not acquire python service lock {LOCK_PATH}")


def release_instance_lock(fd):
    if fd is None:
        return
    try:
        info = _read_lock_info(LOCK_PATH)
        if info and int(info.get("pid") or 0) == os.getpid():
            os.unlink(LOCK_PATH)
    except FileNotFoundError:
        pass
    except OSError:
        pass
    try:
        os.close(fd)
    except OSError:
        pass


def probe_health(host, port, timeout=3.0):
    """Small independent health probe used only to classify a bind clash."""
    try:
        with urllib.request.urlopen(
            f"http://{host}:{port}/health", timeout=timeout
        ) as r:
            body = json.loads(r.read().decode("utf-8") or "{}")
        return body if isinstance(body, dict) else None
    except Exception:
        return None


def _request_shutdown(signum=None, _frame=None):
    """Signal handler: ask serve_forever() to return, then close the socket."""
    global _shutdown_started, _signal_count
    _signal_count += 1
    if _signal_count > 1:
        # Second Ctrl+C / SIGTERM: do not hang a terminal. The lock is stale
        # and safe to recover on the next start (owner PID is validated).
        os._exit(130)
    with _shutdown_lock:
        if _shutdown_started:
            return
        _shutdown_started = True
    name = signal.Signals(signum).name if signum else "shutdown"
    print(f"[py-service] {name}: shutting down", flush=True)
    srv = _srv
    if srv is not None:
        threading.Thread(target=srv.shutdown, name="py-service-stop",
                         daemon=True).start()


def main():
    global _srv
    fd, owner = acquire_instance_lock()
    if fd is None:
        print(
            f"[py-service] not starting a duplicate: this installation's service "
            f"is already running (pid {owner.get('pid')}).",
            flush=True,
        )
        return 0

    srv = None
    try:
        try:
            srv = ServiceHTTPServer((HOST, PORT), Handler)
        except OSError as e:
            if e.errno == errno.EADDRINUSE:
                health = probe_health(HOST, PORT)
                identity = (health or {}).get("identity") or {}
                if (health or {}).get("service") == SERVICE_NAME \
                        and identity.get("install_id") == INSTALL_ID:
                    print(
                        f"[py-service] port {PORT} is already served by this "
                        f"installation (pid {identity.get('pid')}); reusing it.",
                        flush=True,
                    )
                    return 0
                sys.stderr.write(
                    f"[py-service] cannot bind {HOST}:{PORT}: address already in use "
                    "by a process that is not verifiably this AIClipStudio "
                    "installation. Refusing to start or kill it. Stop that "
                    "process or set PY_SERVICE_PORT.\n"
                )
                return 2
            raise

        _srv = srv
        signal.signal(signal.SIGTERM, _request_shutdown)
        signal.signal(signal.SIGINT, _request_shutdown)
        threading.current_thread().name = "py-service"
        print(f"[py-service] listening on http://{HOST}:{PORT} "
              f"(pid {os.getpid()}, install {INSTALL_ID}, "
              f"{sum(1 for m in health_check({}).get('modules', {}).values() if m.get('available'))}"
              f"/7 modules available)", flush=True)
        try:
            srv.serve_forever(poll_interval=0.5)
        finally:
            _srv = None
            try:
                srv.server_close()
            except Exception:
                pass
    finally:
        release_instance_lock(fd)
        print("[py-service] stopped", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())

