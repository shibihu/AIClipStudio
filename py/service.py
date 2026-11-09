# py/service.py — AIClipStudio Python processing service.
# Stdlib HTTP server (no framework) exposing every capability as a JSON
# endpoint. Started automatically by server.js on 127.0.0.1:$PY_SERVICE_PORT.
# Every module degrades independently: a missing dependency yields
# {"ok":false,"error":...} with a clear message, and /health reports exactly
# what works so the Node side can show/hide features.
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from common import ApiError, envelope, jdump  # noqa: E402
import video_ops  # noqa: E402
import vision_ops  # noqa: E402
import image_ops  # noqa: E402
import audio_ops  # noqa: E402
import stt_ops  # noqa: E402
import otio_bridge  # noqa: E402

HOST = os.environ.get("PY_SERVICE_HOST") or "127.0.0.1"
PORT = int(os.environ.get("PY_SERVICE_PORT") or 8611)
MAX_BODY = int(os.environ.get("PY_SERVICE_MAX_BODY") or 32 * 1024 * 1024)

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
}


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
    return {"service": "aiclipstudio-py", "version": 1, "modules": mods,
            "endpoints": sorted(ENDPOINTS)}


def _ver(name):
    try:
        import importlib
        m = importlib.import_module(name if name != "PIL" else "PIL")
        return getattr(m, "__version__", None)
    except Exception:
        return None


class Handler(BaseHTTPRequestHandler):
    server_version = "AIClipStudioPy/1"

    def log_message(self, fmt, *args):  # quieter: only errors get a line
        if " 4" in (args[0] if args else "")[:2] or " 5" in (args[0] if args else "")[:2]:
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


def main():
    ThreadingHTTPServer.daemon_threads = True
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    threading.current_thread().name = "py-service"
    print(f"[py-service] listening on http://{HOST}:{PORT} "
          f"({sum(1 for m in health_check({}).get('modules', {}).values() if m.get('available'))}"
          f"/7 modules available)", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
