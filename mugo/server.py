"""MuGo — personal offline music streaming server.

Runs locally on your laptop. Paste a YouTube link in the web UI and MuGo
downloads the audio + thumbnail into your library in the background, then
streams it from disk (works fully offline once downloaded).
"""
from __future__ import annotations

import argparse
import json
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
import webbrowser
from pathlib import Path

from flask import Flask, abort, jsonify, request, send_file, send_from_directory

FROZEN = getattr(sys, "frozen", False)  # running from the packaged .exe / .app
APP_DIR = Path(__file__).resolve().parent
BUNDLE_DIR = Path(getattr(sys, "_MEIPASS", APP_DIR.parent))
STATIC_DIR = (BUNDLE_DIR / "mugo" / "static") if FROZEN else (APP_DIR / "static")
BUNDLED_BIN = BUNDLE_DIR / "bin"  # ffmpeg / deno shipped inside the installer
DATA_DIR = Path(os.environ.get("MUGO_HOME", Path.home() / "MuGo")).expanduser()
AUDIO_DIR = DATA_DIR / "audio"
THUMB_DIR = DATA_DIR / "thumbs"
DB_PATH = DATA_DIR / "library.json"
YTDLP_ZIP = DATA_DIR / "bin" / "yt-dlp.zip"  # auto-updated copy of yt-dlp

if BUNDLED_BIN.is_dir():
    os.environ["PATH"] = str(BUNDLED_BIN) + os.pathsep + os.environ.get("PATH", "")
ytdlp_ready = threading.Event()

YT_ID_RE = re.compile(
    r"(?:v=|youtu\.be/|/shorts/|/embed/|/live/|/v/)([A-Za-z0-9_-]{11})"
)
PLAYLIST_RE = re.compile(r"[?&]list=([A-Za-z0-9_-]+)")


def now() -> float:
    return time.time()


# --------------------------------------------------------------------------
# Library storage
# --------------------------------------------------------------------------
class Library:
    def __init__(self, path: Path):
        self.path = path
        self.lock = threading.RLock()
        self.songs: dict[str, dict] = {}
        self.playlists: list[dict] = []
        self._dirty = False
        self.load()

    def load(self):
        if self.path.exists():
            try:
                data = json.loads(self.path.read_text("utf-8"))
                self.songs = {s["id"]: s for s in data.get("songs", [])}
                self.playlists = data.get("playlists", [])
            except Exception as e:  # corrupt file: keep a backup, start fresh
                print(f"[MuGo] could not read library ({e}); backing it up")
                shutil.copy(self.path, self.path.with_suffix(".broken.json"))

    def save(self):
        with self.lock:
            data = {"songs": list(self.songs.values()), "playlists": self.playlists}
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(data, indent=1), "utf-8")
            os.replace(tmp, self.path)
            self._dirty = False

    def mark_dirty(self):
        self._dirty = True

    def flush_if_dirty(self):
        if self._dirty:
            self.save()

    def snapshot(self) -> dict:
        with self.lock:
            songs = sorted(self.songs.values(), key=lambda s: s.get("added", 0), reverse=True)
            return {
                "songs": [dict(s) for s in songs],
                "playlists": [dict(p, songs=list(p["songs"])) for p in self.playlists],
            }

    def playlist(self, pid: str) -> dict | None:
        return next((p for p in self.playlists if p["id"] == pid), None)


lib: Library  # initialised in main()
jobs: "queue.Queue[str]" = queue.Queue()


# --------------------------------------------------------------------------
# Downloading
# --------------------------------------------------------------------------
def new_song(vid: str, url: str, title: str | None = None) -> dict:
    return {
        "id": vid,
        "title": title or "Fetching info…",
        "artist": "",
        "duration": 0,
        "url": url,
        "file": None,
        "thumb": False,
        "status": "queued",  # queued | downloading | processing | ready | error
        "progress": 0,
        "error": None,
        "added": now(),
        "source": "youtube",
        "liked": False,
        "plays": 0,
    }


def enqueue_video(vid: str, title: str | None = None) -> dict:
    url = f"https://www.youtube.com/watch?v={vid}"
    with lib.lock:
        song = lib.songs.get(vid)
        if song and song["status"] in ("ready", "queued", "downloading"):
            return song
        if song:  # errored before: retry
            song.update(status="queued", error=None, progress=0)
        else:
            song = new_song(vid, url, title)
            lib.songs[vid] = song
        lib.save()
    jobs.put(vid)
    return song


def fetch_thumb(vid: str, url: str | None = None) -> bool:
    candidates = [url] if url else []
    candidates += [
        f"https://i.ytimg.com/vi/{vid}/maxresdefault.jpg",
        f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg",
    ]
    for c in candidates:
        if not c:
            continue
        try:
            req = urllib.request.Request(c, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=15) as r:
                data = r.read()
            if len(data) > 2000:
                (THUMB_DIR / f"{vid}.jpg").write_bytes(data)
                return True
        except Exception:
            continue
    return False


def update_ytdlp():
    """YouTube changes often and old yt-dlp versions break. The packaged app
    can't pip-upgrade, so keep the newest yt-dlp release (a pure-Python zip)
    in the data folder and import it ahead of the bundled copy."""
    try:
        if not FROZEN and not os.environ.get("MUGO_UPDATE_YTDLP"):
            return  # in a dev checkout, run.sh keeps yt-dlp updated with pip
        YTDLP_ZIP.parent.mkdir(parents=True, exist_ok=True)
        stamp = YTDLP_ZIP.with_suffix(".version")
        # .../releases/latest/download/yt-dlp redirects to .../releases/download/<version>/yt-dlp,
        # so one HEAD request tells us the newest version (no API, no rate limit)
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *a, **k):
                return None
        req = urllib.request.Request("https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp",
                                     headers={"User-Agent": "MuGo"}, method="HEAD")
        try:
            urllib.request.build_opener(NoRedirect).open(req, timeout=10)
            raise RuntimeError("expected a redirect")
        except urllib.error.HTTPError as e:
            if e.code not in (301, 302, 303, 307, 308):
                raise
            location = e.headers.get("Location", "")
        tag = location.rstrip("/").split("/")[-2] if location.count("/") > 2 else ""
        if not re.fullmatch(r"[0-9.]+", tag):
            raise RuntimeError(f"unexpected release tag {tag!r}")
        if YTDLP_ZIP.exists() and stamp.exists() and stamp.read_text().strip() == tag:
            return
        asset_url = f"https://github.com/yt-dlp/yt-dlp/releases/download/{tag}/yt-dlp"
        print(f"[MuGo] updating downloader to yt-dlp {tag}…")
        tmp = YTDLP_ZIP.with_suffix(".part")
        req = urllib.request.Request(asset_url, headers={"User-Agent": "MuGo"})
        with urllib.request.urlopen(req, timeout=60) as r, open(tmp, "wb") as f:
            shutil.copyfileobj(r, f)
        import zipfile
        with zipfile.ZipFile(tmp) as z:  # sanity check before swapping in
            z.getinfo("yt_dlp/__init__.py")
        os.replace(tmp, YTDLP_ZIP)
        stamp.write_text(tag)
    except Exception as e:
        print(f"[MuGo] yt-dlp update skipped ({e.__class__.__name__}: {e})")
    finally:
        if YTDLP_ZIP.exists() and str(YTDLP_ZIP) not in sys.path:
            sys.path.insert(0, str(YTDLP_ZIP))
        ytdlp_ready.set()


def ydl_base_opts() -> dict:
    opts = {"quiet": True, "no_warnings": True, "remote_components": ["ejs:github"]}
    deno = BUNDLED_BIN / ("deno.exe" if os.name == "nt" else "deno")
    if deno.exists():
        opts["js_runtimes"] = {"deno": {"path": str(deno)}}
    else:
        opts["js_runtimes"] = {"deno": {}, "node": {}}
    if (BUNDLED_BIN / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")).exists():
        opts["ffmpeg_location"] = str(BUNDLED_BIN)
    return opts


def import_ytdlp():
    ytdlp_ready.wait(timeout=90)
    import yt_dlp
    return yt_dlp


def download(vid: str):
    yt_dlp = import_ytdlp()

    song = lib.songs.get(vid)
    if not song:
        return
    song.update(status="downloading", progress=0, error=None)
    last_save = [0.0]

    def hook(d):
        if d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            if total:
                song["progress"] = round(d.get("downloaded_bytes", 0) * 100 / total, 1)
        elif d.get("status") == "finished":
            song["status"] = "processing"
            song["progress"] = 100
        if now() - last_save[0] > 5:
            last_save[0] = now()
            lib.mark_dirty()

    opts = {
        **ydl_base_opts(),
        "format": "bestaudio[ext=m4a]/bestaudio/best",
        "outtmpl": str(AUDIO_DIR / f"{vid}.%(ext)s"),
        "noplaylist": True,
        "noprogress": True,
        "progress_hooks": [hook],
        "postprocessors": [
            {"key": "FFmpegExtractAudio", "preferredcodec": "m4a", "preferredquality": "192"}
        ],
    }
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(song["url"], download=True)
        song["title"] = info.get("track") or info.get("title") or vid
        song["artist"] = (
            info.get("artist") or info.get("uploader") or info.get("channel") or ""
        ).removesuffix(" - Topic")
        song["duration"] = info.get("duration") or 0
        files = [p for p in AUDIO_DIR.glob(f"{vid}.*") if p.suffix not in (".part", ".ytdl")]
        m4a = [p for p in files if p.suffix == ".m4a"]
        chosen = (m4a or files or [None])[0]
        if not chosen:
            raise RuntimeError("download finished but no audio file was found")
        song["file"] = chosen.name
        song["thumb"] = fetch_thumb(vid, info.get("thumbnail"))
        song.update(status="ready", progress=100)
        print(f"[MuGo] ✓ {song['title']}")
    except Exception as e:
        msg = re.sub(r"\x1b\[[0-9;]*m", "", str(e)).replace("ERROR: ", "")
        song.update(status="error", error=msg[:300])
        print(f"[MuGo] ✗ {vid}: {msg}")
    lib.save()


def resolve_playlist(url: str):
    yt_dlp = import_ytdlp()

    try:
        with yt_dlp.YoutubeDL({**ydl_base_opts(), "extract_flat": True}) as ydl:
            info = ydl.extract_info(url, download=False)
        for e in info.get("entries") or []:
            vid = e.get("id")
            if vid and len(vid) == 11:
                enqueue_video(vid, e.get("title"))
    except Exception as e:
        print(f"[MuGo] playlist failed: {e}")


def worker():
    while True:
        vid = jobs.get()
        try:
            download(vid)
        except Exception as e:  # never let the worker die
            print(f"[MuGo] worker error: {e}")
        finally:
            jobs.task_done()


def autosave():
    while True:
        time.sleep(3)
        try:
            lib.flush_if_dirty()
        except Exception as e:
            print(f"[MuGo] autosave failed: {e}")


# --------------------------------------------------------------------------
# Editor rendering (ffmpeg)
# --------------------------------------------------------------------------
def atempo_chain(speed: float) -> list[str]:
    parts = []
    s = speed
    while s < 0.5:
        parts.append("atempo=0.5")
        s /= 0.5
    while s > 2.0:
        parts.append("atempo=2.0")
        s /= 2.0
    if abs(s - 1.0) > 1e-4:
        parts.append(f"atempo={s:.5f}")
    return parts


def build_filter(segments: list[dict], pitch_mode: str, fade_in: float, fade_out: float) -> tuple[str, float]:
    n = len(segments)
    lines = [f"[0:a]aresample=44100,asplit={n}" + "".join(f"[in{i}]" for i in range(n))]
    total = 0.0
    for i, seg in enumerate(segments):
        a, b, sp = float(seg["start"]), float(seg["end"]), float(seg.get("speed", 1))
        sp = min(max(sp, 0.25), 3.0)
        chain = [f"atrim=start={a:.4f}:end={b:.4f}", "asetpts=PTS-STARTPTS"]
        if abs(sp - 1) > 1e-4:
            if pitch_mode == "vinyl":  # speed + pitch move together (slowed/nightcore)
                chain += [f"asetrate={44100 * sp:.2f}", "aresample=44100"]
            else:
                chain += atempo_chain(sp)
        out_len = (b - a) / sp
        total += out_len
        f = min(0.008, out_len / 4)  # micro-fades to avoid clicks at cut points
        chain += [f"afade=t=in:d={f:.4f}", f"afade=t=out:st={max(out_len - f, 0):.4f}:d={f:.4f}"]
        lines.append(f"[in{i}]" + ",".join(chain) + f"[s{i}]")
    lines.append("".join(f"[s{i}]" for i in range(n)) + f"concat=n={n}:v=0:a=1[cat]")
    post = []
    if fade_in > 0:
        post.append(f"afade=t=in:d={fade_in:.3f}")
    if fade_out > 0:
        post.append(f"afade=t=out:st={max(total - fade_out, 0):.3f}:d={fade_out:.3f}")
    lines.append("[cat]" + (",".join(post) if post else "anull") + "[out]")
    return ";".join(lines), total


def render_edit(new_id: str, src_path: Path, segments, pitch_mode, fade_in, fade_out):
    song = lib.songs[new_id]
    try:
        graph, total = build_filter(segments, pitch_mode, fade_in, fade_out)
        out = AUDIO_DIR / f"{new_id}.m4a"
        cmd = [
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", str(src_path),
            "-filter_complex", graph, "-map", "[out]", "-c:a", "aac", "-b:a", "192k",
            "-vn", str(out),
        ]
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)  # no flashing console on Windows
        r = subprocess.run(cmd, capture_output=True, text=True, creationflags=flags)
        if r.returncode != 0:
            raise RuntimeError(r.stderr.strip()[-300:] or "ffmpeg failed")
        song.update(file=out.name, duration=round(total, 2), status="ready", progress=100)
    except Exception as e:
        song.update(status="error", error=str(e)[:300])
    lib.save()


# --------------------------------------------------------------------------
# HTTP API
# --------------------------------------------------------------------------
app = Flask(__name__, static_folder=None)


@app.after_request
def no_cache_api(resp):
    if request.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store"
    return resp


@app.get("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.get("/static/<path:p>")
def static_files(p):
    return send_from_directory(STATIC_DIR, p)


@app.get("/api/state")
def state():
    snap = lib.snapshot()
    snap["queued"] = jobs.qsize()
    snap["dataDir"] = str(DATA_DIR)
    return jsonify(snap)


@app.post("/api/add")
def add():
    url = (request.json or {}).get("url", "").strip()
    if not url:
        abort(400, "missing url")
    vid = YT_ID_RE.search(url)
    pl = PLAYLIST_RE.search(url)
    if vid:
        song = enqueue_video(vid.group(1))
        return jsonify({"kind": "video", "song": song})
    if pl:
        threading.Thread(target=resolve_playlist, args=(url,), daemon=True).start()
        return jsonify({"kind": "playlist"})
    if re.fullmatch(r"[A-Za-z0-9_-]{11}", url):
        return jsonify({"kind": "video", "song": enqueue_video(url)})
    return jsonify({"error": "That doesn't look like a YouTube link"}), 400


@app.patch("/api/songs/<sid>")
def update_song(sid):
    body = request.json or {}
    with lib.lock:
        song = lib.songs.get(sid) or abort(404)
        for k in ("title", "artist", "liked"):
            if k in body:
                song[k] = body[k]
        lib.save()
    return jsonify(song)


@app.post("/api/songs/<sid>/played")
def played(sid):
    song = lib.songs.get(sid) or abort(404)
    song["plays"] = song.get("plays", 0) + 1
    song["lastPlayed"] = now()
    lib.mark_dirty()
    return jsonify(ok=True)


@app.post("/api/songs/<sid>/retry")
def retry(sid):
    song = lib.songs.get(sid) or abort(404)
    if song["source"] != "youtube":
        abort(400)
    song.update(status="queued", error=None, progress=0)
    jobs.put(sid)
    lib.save()
    return jsonify(song)


@app.delete("/api/songs/<sid>")
def delete_song(sid):
    with lib.lock:
        song = lib.songs.pop(sid, None) or abort(404)
        for p in lib.playlists:
            p["songs"] = [s for s in p["songs"] if s != sid]
        lib.save()
    if song.get("file"):
        (AUDIO_DIR / song["file"]).unlink(missing_ok=True)
    (THUMB_DIR / f"{sid}.jpg").unlink(missing_ok=True)
    return jsonify(ok=True)


@app.get("/media/audio/<sid>")
def audio(sid):
    song = lib.songs.get(sid)
    if not song or not song.get("file"):
        abort(404)
    path = AUDIO_DIR / song["file"]
    if not path.exists():
        abort(404)
    dl = request.args.get("download")
    name = re.sub(r'[\\/:*?"<>|]', "", f"{song['title']}{path.suffix}")
    return send_file(path, conditional=True, as_attachment=bool(dl), download_name=name)


@app.get("/media/thumb/<sid>")
def thumb(sid):
    path = THUMB_DIR / f"{sid}.jpg"
    if not path.exists():
        abort(404)
    resp = send_file(path, conditional=True)
    resp.headers["Cache-Control"] = "public, max-age=86400"
    return resp


# ---- playlists ----
@app.post("/api/playlists")
def create_playlist():
    body = request.json or {}
    pl = {
        "id": uuid.uuid4().hex[:10],
        "name": (body.get("name") or "New playlist").strip()[:80],
        "songs": [s for s in body.get("songs", []) if s in lib.songs],
        "created": now(),
    }
    with lib.lock:
        lib.playlists.append(pl)
        lib.save()
    return jsonify(pl)


@app.patch("/api/playlists/<pid>")
def update_playlist(pid):
    body = request.json or {}
    with lib.lock:
        pl = lib.playlist(pid) or abort(404)
        if "name" in body:
            pl["name"] = body["name"].strip()[:80] or pl["name"]
        if "songs" in body:
            pl["songs"] = [s for s in body["songs"] if s in lib.songs]
        if "add" in body:
            for s in body["add"]:
                if s in lib.songs and s not in pl["songs"]:
                    pl["songs"].append(s)
        lib.save()
    return jsonify(pl)


@app.delete("/api/playlists/<pid>")
def delete_playlist(pid):
    with lib.lock:
        lib.playlists = [p for p in lib.playlists if p["id"] != pid]
        lib.save()
    return jsonify(ok=True)


# ---- editor ----
@app.post("/api/edit")
def edit():
    body = request.json or {}
    src = lib.songs.get(body.get("source")) or abort(404)
    if src["status"] != "ready":
        abort(400, "source not ready")
    segs = [s for s in body.get("segments", []) if float(s["end"]) - float(s["start"]) > 0.01]
    if not segs:
        return jsonify({"error": "Nothing left to render — every part was cut."}), 400
    new_id = "edit-" + uuid.uuid4().hex[:8]
    song = new_song(new_id, src["url"], (body.get("title") or f"{src['title']} (edit)")[:120])
    song.update(
        artist=src.get("artist", ""), source="edit", parent=src["id"], status="processing",
        thumb=src.get("thumb", False),
    )
    if src.get("thumb"):
        shutil.copy(THUMB_DIR / f"{src['id']}.jpg", THUMB_DIR / f"{new_id}.jpg")
    with lib.lock:
        lib.songs[new_id] = song
        lib.save()
    threading.Thread(
        target=render_edit,
        args=(new_id, AUDIO_DIR / src["file"], segs, body.get("pitch", "keep"),
              float(body.get("fadeIn", 0)), float(body.get("fadeOut", 0))),
        daemon=True,
    ).start()
    return jsonify(song)


# --------------------------------------------------------------------------
def already_running(port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/state", timeout=2) as r:
            return r.status == 200
    except Exception:
        return False


def open_app_window(url: str):
    """Open MuGo in its own chromeless window (Edge/Chrome app mode) so it
    feels like a desktop app; fall back to the default browser."""
    candidates = []
    if os.name == "nt":
        for base in filter(None, (os.environ.get("PROGRAMFILES(X86)"), os.environ.get("PROGRAMFILES"),
                                  os.environ.get("LOCALAPPDATA"))):
            candidates += [Path(base) / "Microsoft/Edge/Application/msedge.exe",
                           Path(base) / "Google/Chrome/Application/chrome.exe"]
    elif sys.platform == "darwin":
        candidates += [Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
                       Path("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge")]
    else:
        candidates += [Path(p) for p in filter(None, (shutil.which("google-chrome"), shutil.which("chromium"),
                                                     shutil.which("microsoft-edge")))]
    for exe in candidates:
        if exe.exists():
            try:
                subprocess.Popen([str(exe), f"--app={url}", "--window-size=1360,880"],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                return
            except Exception:
                pass
    webbrowser.open(url)


def main():
    global lib
    ap = argparse.ArgumentParser(description="MuGo music server")
    ap.add_argument("--port", type=int, default=int(os.environ.get("MUGO_PORT", 7777)))
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--browser-tab", action="store_true", help="open a normal browser tab, not an app window")
    ap.add_argument("--tray", action="store_true", help="run from a system-tray icon")
    args = ap.parse_args()

    windowed = sys.stdout is None or sys.stderr is None
    if windowed:  # windowed .exe has no console: log to a file instead
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        log = open(DATA_DIR / "mugo.log", "a", buffering=1, encoding="utf-8")
        sys.stdout, sys.stderr = log, log

    url = f"http://{'localhost' if args.host in ('127.0.0.1', '0.0.0.0') else args.host}:{args.port}"
    opener = (lambda: webbrowser.open(url)) if args.browser_tab else (lambda: open_app_window(url))

    # double-clicked again while already running: just show the window
    if already_running(args.port):
        print("[MuGo] already running — opening it")
        if not args.no_browser:
            opener()
        return

    for d in (AUDIO_DIR, THUMB_DIR):
        d.mkdir(parents=True, exist_ok=True)
    lib = Library(DB_PATH)

    if not shutil.which("ffmpeg"):
        print("[MuGo] ⚠ ffmpeg not found — downloads and the editor need it. See README.")

    # resume anything that was interrupted last time
    for s in lib.songs.values():
        if s["source"] == "youtube" and s["status"] in ("queued", "downloading", "processing"):
            s["status"] = "queued"
            jobs.put(s["id"])
        elif s["source"] == "edit" and s["status"] == "processing":
            s.update(status="error", error="Render was interrupted — open it in the editor again")
    lib.save()

    threading.Thread(target=update_ytdlp, daemon=True).start()
    for _ in range(2):
        threading.Thread(target=worker, daemon=True).start()
    threading.Thread(target=autosave, daemon=True).start()

    print(f"\n  ♪ MuGo is running →  {url}\n  Library folder: {DATA_DIR}\n"
          f"  Keep this window open while you listen. Close it to quit MuGo.\n")
    if not args.no_browser:
        threading.Timer(1.0, opener).start()

    import logging
    logging.getLogger("werkzeug").setLevel(logging.WARNING)
    serve = lambda: app.run(host=args.host, port=args.port, threaded=True, debug=False)
    if args.tray or windowed:
        return run_with_tray(serve, opener)
    serve()


def run_with_tray(serve, opener):
    """Packaged app: no console window — live in the system tray instead."""
    server = threading.Thread(target=serve, daemon=True)
    server.start()
    try:
        _tray_loop(opener)
    except Exception as e:  # no tray available: keep serving without one
        print(f"[MuGo] tray unavailable ({e}); still running")
        server.join()


def _tray_loop(opener):
    import pystray
    from PIL import Image

    ico = BUNDLE_DIR / "packaging" / "mugo.ico"
    if not ico.exists():
        ico = APP_DIR.parent / "packaging" / "mugo.ico"
    image = Image.open(ico) if ico.exists() else Image.new("RGBA", (64, 64), (244, 114, 182, 255))

    def quit_app(icon, _item):
        try:
            lib.save()
        finally:
            icon.stop()

    menu = pystray.Menu(
        pystray.MenuItem("Open MuGo", lambda *_: opener(), default=True),
        pystray.MenuItem("Open library folder", lambda *_: open_folder(DATA_DIR)),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Quit MuGo", quit_app),
    )
    pystray.Icon("MuGo", image, "MuGo — music", menu).run()


def open_folder(path: Path):
    if os.name == "nt":
        os.startfile(path)  # type: ignore[attr-defined]
    elif sys.platform == "darwin":
        subprocess.Popen(["open", str(path)])
    else:
        subprocess.Popen(["xdg-open", str(path)])


if __name__ == "__main__":
    main()
