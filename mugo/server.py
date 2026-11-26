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
_FF_FILTERS: set[str] | None = None


def ff_has(name: str) -> bool:
    """Which optional ffmpeg filters/resamplers this ffmpeg build has (cached)."""
    global _FF_FILTERS
    if _FF_FILTERS is None:
        try:
            flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
            out = subprocess.run(["ffmpeg", "-hide_banner", "-filters"], capture_output=True, text=True,
                                 creationflags=flags).stdout
            conf = subprocess.run(["ffmpeg", "-hide_banner", "-buildconf"], capture_output=True, text=True,
                                  creationflags=flags).stdout
            _FF_FILTERS = {ln.split()[1] for ln in out.splitlines() if len(ln.split()) > 2}
            if "libsoxr" in conf:
                _FF_FILTERS.add("soxr")
        except Exception:
            _FF_FILTERS = set()
    return name in _FF_FILTERS


_AFIR_NORM: str | None = None


def afir_norm() -> str:
    """Energy-normalise the reverb impulse response. The option was renamed
    between ffmpeg 6 (gtype=gn) and 7 (irnorm=2), so ask this ffmpeg."""
    global _AFIR_NORM
    if _AFIR_NORM is None:
        try:
            h = subprocess.run(["ffmpeg", "-hide_banner", "-h", "filter=afir"], capture_output=True, text=True,
                               creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)).stdout
        except Exception:
            h = ""
        _AFIR_NORM = ":irnorm=2" if "irnorm" in h else ":gtype=gn" if "gtype" in h else ""
    return _AFIR_NORM


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


def stretch_chain(speed: float) -> list[str]:
    """Change tempo without changing pitch, studio-style.
    Rubber Band (the engine used by many DAWs) with phase-coherent stereo,
    formant preservation and its high-quality pitch path; WSOLA (atempo) only
    as a fallback when this ffmpeg build lacks librubberband."""
    if ff_has("rubberband"):
        return [
            f"rubberband=tempo={speed:.5f}:pitch=1:transients=mixed:detector=compound:phase=laminar"
            ":window=standard:formant=preserved:pitchq=quality:channels=together"
        ]
    return atempo_chain(speed)


def resample_opts() -> str:
    return ":resampler=soxr:precision=28" if ff_has("soxr") else ""


REVERBS = {  # name: (tail seconds, pre-delay ms, lowpass on the tail)
    "room": (1.4, 18, 7500),
    "hall": (3.2, 35, 6000),
    "dreamy": (5.8, 55, 4500),
}
# With an energy-normalised IR (after the low-cut) the wet signal comes out ~6.3 dB louder than
# the dry signal (measured on music); subtract that so `amount` maps to a real ratio.
REVERB_CAL_DB = 6.3


def reverb_weight(amount: float) -> float:
    """amount 0..1 → wet mix weight. 0.3 ≈ subtle (-11 dB), 0.7 ≈ lush (-4 dB), 1.0 ≈ as loud as the song."""
    amount = max(0.0, min(1.0, amount))
    rel_db = -16 + 17 * amount
    return 10 ** ((rel_db - REVERB_CAL_DB) / 20)


def build_filter(segments: list[dict], opts: dict) -> tuple[str, float]:
    pitch_mode = opts.get("pitch", "keep")
    fade_in, fade_out = float(opts.get("fadeIn", 0)), float(opts.get("fadeOut", 0))
    rs = resample_opts()
    # "repeat this part" = the segment appears N times in a row
    segments = [s for s in segments for _ in range(max(1, min(8, int(s.get("rep", 1) or 1))))]
    n = len(segments)
    lines = [f"[0:a]aresample=44100{rs},aformat=sample_fmts=fltp:channel_layouts=stereo,asplit={n}"
             + "".join(f"[in{i}]" for i in range(n))]
    total = 0.0
    d8_parts: list[tuple[float, float]] = []  # output-time spans marked for 8D
    for i, seg in enumerate(segments):
        a, b, sp = float(seg["start"]), float(seg["end"]), float(seg.get("speed", 1))
        sp = min(max(sp, 0.25), 3.0)
        chain = [f"atrim=start={a:.4f}:end={b:.4f}", "asetpts=PTS-STARTPTS"]
        if seg.get("rev"):
            chain.append("areverse")
        if seg.get("mute"):
            chain.append("volume=0")
        if abs(sp - 1) > 1e-4:
            if pitch_mode == "vinyl":  # true varispeed: pitch follows speed, like slowing a turntable
                chain += [f"asetrate={44100 * sp:.3f}", f"aresample=44100{rs}"]
            else:
                chain += stretch_chain(sp)
        out_len = (b - a) / sp
        if seg.get("d8"):
            if d8_parts and abs(d8_parts[-1][1] - total) < 1e-3:
                d8_parts[-1] = (d8_parts[-1][0], total + out_len)
            else:
                d8_parts.append((total, total + out_len))
        total += out_len
        f = min(0.012, out_len / 4)  # tiny fades so cut points never click
        chain += [f"afade=t=in:d={f:.4f}:curve=qsin", f"afade=t=out:st={max(out_len - f, 0):.4f}:d={f:.4f}:curve=qsin"]
        lines.append(f"[in{i}]" + ",".join(chain) + f"[s{i}]")
    lines.append("".join(f"[s{i}]" for i in range(n)) + f"concat=n={n}:v=0:a=1[cat]")
    last = "cat"
    tone = []
    semis = max(-12.0, min(12.0, float(opts.get("semitones", 0) or 0)))
    if abs(semis) > 0.01:  # extra pitch shift (deeper / higher) without changing the tempo
        ratio = 2 ** (semis / 12)
        if ff_has("rubberband"):
            # formants shift with the pitch, so voices really sound deeper, not just "transposed"
            tone.append(f"rubberband=pitch={ratio:.6f}:tempo=1:transients=mixed:phase=laminar"
                        ":formant=shifted:pitchq=quality:channels=together")
        else:
            tone += [f"asetrate={44100 * ratio:.3f}", f"aresample=44100{rs}", *atempo_chain(1 / ratio)]
    if opts.get("warm"):  # darker, heavier tone: low-shelf boost + softened highs
        tone += ["bass=g=5:f=95:w=0.7", "equalizer=f=250:t=q:w=1:g=1.5", "treble=g=-4:f=5500:w=0.6"]
    if tone:
        lines.append("[cat]" + ",".join(tone) + "[tone]")
        last = "tone"
    last = fx_lines(lines, last, opts.get("fx") or {}, total)
    mode8d = opts.get("eightD") or "off"
    if mode8d == "all" or (mode8d == "parts" and d8_parts):
        lines += eight_d_lines(last, "e8d", float(opts.get("eightDPeriod", 8) or 8),
                               None if mode8d == "all" else d8_parts)
        last = "e8d"
    rev = REVERBS.get(opts.get("reverb") or "")
    if rev:  # convolution reverb with a generated, decorrelated stereo impulse response
        tail, predelay, lp = rev
        wet = reverb_weight(float(opts.get("reverbAmount", 0.7)))
        for ch, seed in (("l", 7), ("r", 13)):  # decorrelated L/R tails = wide stereo space
            lines.append(f"anoisesrc=d={tail}:c=pink:r=44100:a=0.9:seed={seed},lowpass=f={lp},"
                         f"afade=t=in:d=0.012,afade=t=out:st=0:d={tail}:curve=exp[ir{ch}]")
        lines.append("[irl][irr]join=inputs=2:channel_layout=stereo[ir]")
        lines.append(f"[{last}]asplit=2[dry][send]")
        # pre-delay keeps the original clear; the low-cut stops the tail turning the bass to mud
        lines.append(f"[send]adelay={predelay}|{predelay},highpass=f=180[sendp]")
        lines.append(f"[sendp][ir]afir=dry=1:wet=1{afir_norm()}[wet]")
        lines.append(f"[dry][wet]amix=inputs=2:weights=1 {wet:.5f}:normalize=0:duration=first[rv]")
        last = "rv"
        total += 0  # the tail is cut to the song length (duration=first)
    post = []
    fx = opts.get("fx") or {}
    punch = fx.get("punch", 0)
    if punch > 0.01:   # compressor: more punch = lower threshold, higher ratio, auto make-up
        post.append(f"acompressor=threshold={-10 - 20 * punch:.1f}dB:ratio={2 + 4 * punch:.2f}:attack=8:release=140"
                    f":makeup={10 ** (makeup('punch', punch) / 20):.3f}:knee=4")
    if fade_in > 0:
        post.append(f"afade=t=in:d={fade_in:.3f}")
    if fade_out > 0:
        post.append(f"afade=t=out:st={max(total - fade_out, 0):.3f}:d={fade_out:.3f}")
    post.append("alimiter=limit=0.97:attack=3:release=60:level=false")  # never clip
    lines.append(f"[{last}]" + ",".join(post) + "[out]")
    return ";".join(lines), total


FX_DEFAULTS = {
    "eq": [0, 0, 0, 0, 0], "vocals": 0, "width": 1, "drive": 0, "crush": 0, "radio": 0, "lofi": 0,
    "chorus": 0, "flanger": 0, "phaser": 0, "trem": 0, "tremRate": 5, "vib": 0, "vibRate": 5,
    "echo": 0, "echoTime": 350, "echoFb": 0.35, "punch": 0, "gain": 0, "loud": "off",
}
LOUDNESS = {"streaming": -14, "loud": -9, "max": -7}


def clean_fx(raw) -> dict:
    """Sanitise the effect settings sent by the Studio (all numbers clamped to safe ranges)."""
    raw = raw if isinstance(raw, dict) else {}
    num = lambda k, lo, hi: max(lo, min(hi, float(raw.get(k, FX_DEFAULTS[k]) or 0)))
    eq = raw.get("eq") if isinstance(raw.get("eq"), list) else []
    return {
        "eq": [max(-15.0, min(15.0, float(v or 0))) for v in (eq + [0] * 5)[:5]],
        "vocals": num("vocals", 0, 1), "width": num("width", 0, 2), "drive": num("drive", 0, 1),
        "crush": num("crush", 0, 1), "radio": num("radio", 0, 1), "lofi": num("lofi", 0, 1),
        "chorus": num("chorus", 0, 1), "flanger": num("flanger", 0, 1), "phaser": num("phaser", 0, 1),
        "trem": num("trem", 0, 1), "tremRate": num("tremRate", 0.5, 16), "vib": num("vib", 0, 1),
        "vibRate": num("vibRate", 0.5, 12), "echo": num("echo", 0, 1), "echoTime": num("echoTime", 40, 1500),
        "echoFb": num("echoFb", 0, 0.9), "punch": num("punch", 0, 1), "gain": num("gain", -18, 18),
        "loud": raw.get("loud") if raw.get("loud") in LOUDNESS else "off",
    }


# Auto gain: measured loudness change of each effect on real music at amount 0 / 50 / 100 %,
# given back right after the effect so every effect changes the sound, not the volume.
FX_MAKEUP = {
    "vocals": (0, 1.4, -1.1), "drive": (0, 0.5, 3.8), "radio": (0, 4.2, 3.2), "lofi": (0, 4.0, 5.8),
    "chorus": (0, -0.6, -2.2), "flanger": (0, 3.2, 5.2), "phaser": (0, 0.7, -0.2), "trem": (0, 2.0, 3.8),
    "echo": (0, -0.6, -2.2), "punch": (0, 9.5, 17.9),
}


def makeup(name: str, amt: float) -> float:
    a, b, c = FX_MAKEUP[name]
    return a + (b - a) * amt * 2 if amt <= 0.5 else b + (c - b) * (amt - 0.5) * 2


EQ_BANDS = [("lowshelf", 60, 0), ("peak", 250, 1.0), ("peak", 1000, 1.0), ("peak", 3500, 1.1), ("highshelf", 10000, 0)]


def fx_lines(lines: list, last: str, fx: dict, total: float) -> str:
    """The effects rack. Appends filtergraph lines, returns the new output label.
    Order: vocals → EQ → drive → bitcrush → radio → lo-fi → chorus → flanger → phaser →
    vibrato → tremolo → echo → stereo width (dynamics and volume come at the very end)."""
    if not fx:
        return last
    n = [0]
    def step(chain: str) -> None:            # simple in → out filter chain
        nonlocal last
        n[0] += 1; out = f"fx{n[0]}"
        lines.append(f"[{last}]{chain}[{out}]"); last = out
    def blend(wet_chain: str, wet: float, dry: float = None) -> None:   # parallel wet/dry mix
        nonlocal last
        n[0] += 1; k = n[0]; dry = 1 - wet if dry is None else dry
        lines.append(f"[{last}]asplit=2[fxd{k}][fxw{k}]")
        lines.append(f"[fxw{k}]{wet_chain}[fxw{k}o]")
        lines.append(f"[fxd{k}][fxw{k}o]amix=inputs=2:weights={dry:.4f} {wet:.4f}:normalize=0:duration=first[fx{k}]")
        last = f"fx{k}"

    if fx["vocals"] > 0.01:   # karaoke: keep the sides + the bass, drop the centre (where vocals live)
        n[0] += 1; k = n[0]
        lines.append(f"[{last}]asplit=2[vk{k}a][vk{k}b]")
        lines.append(f"[vk{k}b]asplit=2[vk{k}s][vk{k}m]")
        lines.append(f"[vk{k}s]pan=stereo|c0=0.5*c0-0.5*c1|c1=-0.5*c0+0.5*c1[vk{k}side]")
        lines.append(f"[vk{k}m]pan=stereo|c0=0.5*c0+0.5*c1|c1=0.5*c0+0.5*c1,lowpass=f=150,lowpass=f=150[vk{k}low]")
        lines.append(f"[vk{k}side][vk{k}low]amix=inputs=2:normalize=0[vk{k}kar]")
        v = fx["vocals"]
        lines.append(f"[vk{k}a][vk{k}kar]amix=inputs=2:weights={1 - v:.4f} {v * 1.4:.4f}:normalize=0:duration=first[fx{k}]")
        last = f"fx{k}"
        step(f"volume={makeup('vocals', v):.2f}dB")
    eq = [f"{'bass' if t == 'lowshelf' else 'treble'}=g={g:.2f}:f={f}:w=0.7" if t != "peak"
          else f"equalizer=f={f}:t=q:w={q}:g={g:.2f}"
          for (t, f, q), g in zip(EQ_BANDS, fx["eq"]) if abs(g) > 0.05]
    if eq:
        step(",".join(eq))
    if fx["drive"] > 0.01:   # tube-style saturation: push into a soft clipper, then level back down
        d = fx["drive"]; pre = 2 + 22 * d
        blend(f"volume={pre:.2f}dB,asoftclip=type=tanh,volume={-pre * 0.62:.2f}dB", min(1, 0.35 + d), max(0, 0.65 - d))
        step(f"volume={makeup('drive', d):.2f}dB")
    if fx["crush"] > 0.01:
        c = fx["crush"]
        step(f"acrusher=bits={16 - 12 * c:.2f}:samples={1 + 9 * c:.2f}:mix={min(1, 0.3 + 0.7 * c):.3f}:mode=lin:aa=0.6")
    if fx["radio"] > 0.01:   # telephone / old radio band
        blend("highpass=f=420,highpass=f=420,lowpass=f=3300,lowpass=f=3300,volume=8dB,asoftclip=type=tanh,volume=-2dB", fx["radio"])
        step(f"volume={makeup('radio', fx['radio']):.2f}dB")
    if fx["lofi"] > 0.01:    # tape: darker, thinner, wobbly, with vinyl crackle
        l = fx["lofi"]
        step(f"highpass=f={40 + 160 * l:.0f},lowpass=f={14000 - 10000 * l:.0f},"
             f"vibrato=f=0.7:d={0.03 + 0.17 * l:.3f}")
        step(f"volume={makeup('lofi', l):.2f}dB")
        # vinyl crackle, generated inside the music stream itself (a separate noise source would
        # have to be kept in sync with the song, which breaks with edited / joined parts)
        thr, amp = 1 - 0.0009 * l, 0.5 * l
        step(f"aeval='val(0)+gt(random(0),{thr:.6f})*(random(1)-0.5)*{amp:.3f}"
             f"|val(1)+gt(random(2),{thr:.6f})*(random(3)-0.5)*{amp:.3f}':c=same")
    if fx["chorus"] > 0.01:
        c = fx["chorus"]
        step(f"chorus=0.8:0.9:42|55|67:{0.45 * c:.3f}|{0.4 * c:.3f}|{0.35 * c:.3f}:0.25|0.4|0.31:2|2.3|1.8,"
             f"volume={makeup('chorus', c):.2f}dB")
    if fx["flanger"] > 0.01:
        f_ = fx["flanger"]
        step(f"flanger=delay=1:depth={1 + 4 * f_:.2f}:regen={20 + 40 * f_:.0f}:width={40 + 50 * f_:.0f}:speed=0.35:shape=sinusoidal:interp=quadratic,"
             f"volume={makeup('flanger', f_):.2f}dB")
    if fx["phaser"] > 0.01:
        blend(f"aphaser=in_gain=0.6:out_gain=0.9:delay=3:decay={0.4 + 0.45 * fx['phaser']:.2f}:speed=0.45:type=t", fx["phaser"] * 0.8)
        step(f"volume={makeup('phaser', fx['phaser']):.2f}dB")
    if fx["vib"] > 0.01:
        step(f"vibrato=f={fx['vibRate']:.2f}:d={0.05 + 0.6 * fx['vib']:.3f}")
    if fx["trem"] > 0.01:
        step(f"tremolo=f={fx['tremRate']:.2f}:d={0.9 * fx['trem']:.3f},volume={makeup('trem', fx['trem']):.2f}dB")
    if fx["echo"] > 0.01:    # repeating echo: 6 taps, each one quieter by the feedback amount
        t, fb, m = fx["echoTime"], fx["echoFb"], fx["echo"]
        taps = [i * t for i in range(1, 7) if i * t < 5000]
        decays = [m * 0.8 * fb ** i for i in range(len(taps))]
        step(f"aecho=in_gain=1:out_gain=1:delays={'|'.join(f'{d:.0f}' for d in taps)}"
             f":decays={'|'.join(f'{max(d, 0.001):.4f}' for d in decays)},volume={makeup('echo', m):.2f}dB")
    if abs(fx["width"] - 1) > 0.01:   # mid/side width: 0 = mono, 1 = original, 2 = extra wide
        w = fx["width"]; a, b = 0.5 + 0.5 * w, 0.5 - 0.5 * w
        step(f"pan=stereo|c0={a:.4f}*c0+{b:.4f}*c1|c1={b:.4f}*c0+{a:.4f}*c1")
    return last


def eight_d_lines(inp: str, out: str, period: float, parts) -> list[str]:
    """8D audio: the song circles around the listener's head (for headphones).

    Built from cues the brain uses to place a sound:
      * equal-power left/right panning that follows a circle,
      * a duller (low-passed) sound when the source is behind the head,
      * head shadow: the ear facing away hears a softened version,
      * a little of the original stereo mix kept for body.
    `parts` = output-time spans to apply it to (None = whole song), with
    0.6 s crossfades in and out of each span."""
    period = max(2.0, min(30.0, period))
    th = f"2*PI*t/{period:.3f}"
    if parts:
        gate = "min(1," + "+".join(
            f"clip((t-{a:.3f})/0.6,0,1)*clip(({b:.3f}-t)/0.6,0,1)" for a, b in parts) + ")"
    else:
        gate = "1"
    # Every gain depends only on time, so each path is a time-varying `volume` evaluated per
    # 256-sample block (≈6 ms, far finer than the ear can hear for a slow rotation) — fast.
    x = f"(0.88*sin({th}))"           # -1 = hard left … +1 = hard right
    fb = f"((1+cos({th}))/2)"         # 1 = in front of you, 0 = behind
    k = f"(0.85*1.18*{gate})"
    gains = {}
    for ear, pan, shadow in (("L", f"cos(({x}+1)*PI/4)", f"(0.75*max(0,{x}))"),
                             ("R", f"sin(({x}+1)*PI/4)", f"(0.75*max(0,-{x}))")):
        gains[ear] = {
            "front": f"{k}*{pan}*(1-{shadow})*{fb}",
            "back": f"{k}*{pan}*(1-{shadow})*(1-{fb})",
            "shadow": f"{k}*{pan}*{shadow}",
            "orig": f"1-0.85*{gate}",
        }
    vol = lambda e: f"volume='{e}':eval=frame"
    lines = [
        f"[{inp}]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,asetnsamples=n=256,asplit=2[e8o][e8s]",
        "[e8o]channelsplit=channel_layout=stereo[e8oL][e8oR]",
        "[e8s]pan=mono|c0=0.5*c0+0.5*c1,asplit=3[e8m][e8b][e8h]",
        "[e8b]lowpass=f=3200,lowpass=f=3200[e8bl]",            # behind the head: duller
        "[e8h]lowpass=f=1300[e8hl]",                           # head shadow on the far ear
        "[e8m]asplit=2[e8mL][e8mR]", "[e8bl]asplit=2[e8bL][e8bR]", "[e8hl]asplit=2[e8hL][e8hR]",
    ]
    for ear in ("L", "R"):
        g = gains[ear]
        lines += [
            f"[e8m{ear}]{vol(g['front'])}[e8f{ear}2]",
            f"[e8b{ear}]{vol(g['back'])}[e8b{ear}2]",
            f"[e8h{ear}]{vol(g['shadow'])}[e8h{ear}2]",
            f"[e8o{ear}]{vol(g['orig'])}[e8o{ear}2]",
            f"[e8f{ear}2][e8b{ear}2][e8h{ear}2][e8o{ear}2]amix=inputs=4:normalize=0:duration=first[e8{ear}]",
        ]
    lines.append(f"[e8L][e8R]join=inputs=2:channel_layout=stereo,aformat=sample_fmts=fltp:channel_layouts=stereo[{out}]")
    return lines


def _ff(args: list) -> subprocess.CompletedProcess:
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)  # no flashing console on Windows
    r = subprocess.run(["ffmpeg", "-y", "-hide_banner", *args], capture_output=True, text=True, creationflags=flags)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip()[-300:] or "ffmpeg failed")
    return r


def codec_for(out: Path) -> list:
    return ["-c:a", "pcm_f32le"] if out.suffix == ".wav" else ["-c:a", "aac", "-b:a", "256k"]


def measure_lufs(path: Path) -> float:
    r = _ff(["-nostats", "-i", str(path), "-af", "ebur128=framelog=quiet", "-f", "null", "-"])
    m = re.findall(r"I:\s+(-?[\d.]+) LUFS", r.stderr)
    return float(m[-1]) if m else -23.0


_lufs_cache: dict = {}


def song_lufs(path: Path) -> float:
    key = (str(path), path.stat().st_mtime)
    if key not in _lufs_cache:
        _lufs_cache[key] = measure_lufs(path)
    return _lufs_cache[key]


def finalize(src: Path, out: Path, loud: str, ref: Path | None = None, gain_db: float = 0.0) -> None:
    """Set the loudness of a lossless render and encode it once.
    loud = a LOUDNESS target, or "off" = match the original song (`ref`) so effects change the
    sound, not the volume. `gain_db` (the Volume slider) is applied on top."""
    target = LOUDNESS.get(loud)
    if target is None:
        if ref is None:
            if src != out:
                _ff(["-loglevel", "error", "-i", str(src), *codec_for(out), "-vn", str(out)])
            return
        target = song_lufs(ref)
    target = max(-40.0, min(-5.0, target + gain_db))
    # measure → gain → limiter (peaks ≤ -1 dBFS) → measure again and correct once if the limiter
    # took loudness away (that's how loud masters are made; a pure gain change can't go louder)
    tmp = out.with_suffix(".final" + out.suffix) if src == out else out
    stage = out.with_name(out.stem + ".stage.wav")
    try:
        have = measure_lufs(src)
        if have < -69:          # silence: nothing to level
            _ff(["-loglevel", "error", "-i", str(src), *codec_for(out), "-vn", str(tmp)])
        else:
            gain = max(-30.0, min(24.0, target - have))
            lim = "alimiter=limit=0.85:attack=5:release=80:asc=1:asc_level=0.5:level=false"
            _ff(["-loglevel", "error", "-i", str(src), "-af", f"volume={gain:.2f}dB,{lim}", "-c:a", "pcm_f32le", str(stage)])
            short = target - measure_lufs(stage)
            if short > 0.4:     # the limiter ate some loudness: push a bit more into it
                gain = min(24.0, gain + short * 1.1)
            _ff(["-loglevel", "error", "-i", str(src), "-af", f"volume={gain:.2f}dB,{lim}", *codec_for(out), "-vn", str(tmp)])
    finally:
        stage.unlink(missing_ok=True)
    if tmp != out:
        os.replace(tmp, out)


def run_render(src_path: Path, segments, opts: dict, out: Path, match: bool = True) -> float:
    """Render lossless, then one measured pass sets the loudness and encodes.
    match=False skips loudness work (used for the in-between file of a 16D render)."""
    graph, total = build_filter(segments, opts)
    fx = opts.get("fx") or {}
    first = out.with_name(out.stem + ".lossless.wav") if match or out.suffix != ".wav" else out
    _ff(["-loglevel", "error", "-i", str(src_path), "-filter_complex", graph, "-map", "[out]",
         *codec_for(first), "-vn", str(first)])
    if first != out:
        try:
            if match:
                finalize(first, out, fx.get("loud", "off"), ref=src_path, gain_db=fx.get("gain", 0))
            else:
                finalize(first, out, "off")
        finally:
            first.unlink(missing_ok=True)
    return total


def render_edit(new_id: str, src_path: Path, segments, opts: dict):
    song = lib.songs[new_id]
    try:
        out = AUDIO_DIR / f"{new_id}.m4a"
        total = run_render(src_path, segments, opts, out)
        song.update(file=out.name, duration=round(total, 2), status="ready", progress=100)
    except Exception as e:
        song.update(status="error", error=str(e)[:300])
    lib.save()


# --------------------------------------------------------------------------
# HTTP API
# --------------------------------------------------------------------------
app = Flask(__name__, static_folder=None)
app.config["MAX_CONTENT_LENGTH"] = 1024 * 1024 * 1024  # 16D renders arrive as WAV (≈10 MB per minute)


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
        for k in ("title", "artist", "liked", "hidden"):
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


IMAGE_MAGIC = (b"\xff\xd8\xff", b"\x89PNG", b"GIF8", b"RIFF", b"BM")


@app.post("/api/songs/<sid>/thumb")
def upload_thumb(sid):
    """Set a custom cover image (any common image type; stored as JPEG)."""
    song = lib.songs.get(sid) or abort(404)
    f = request.files.get("image")
    if not f:
        return jsonify({"error": "No image received"}), 400
    data = f.read()
    if len(data) > 25 * 1024 * 1024:
        return jsonify({"error": "That image is too big (max 25 MB)"}), 413
    if not data.startswith(IMAGE_MAGIC) and b"ftypavif" not in data[:32] and b"ftypheic" not in data[:32]:
        return jsonify({"error": "That file isn't an image MuGo can use (try JPG, PNG or WebP)"}), 400
    out = THUMB_DIR / f"{sid}.jpg"
    tmp = THUMB_DIR / f"{sid}.upload"
    tmp.write_bytes(data)
    try:
        # normalise to a reasonably sized JPEG; keep the raw file if ffmpeg can't read it
        r = subprocess.run(
            ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", str(tmp), "-frames:v", "1",
             "-vf", "scale='min(1200,iw)':-2", "-q:v", "3", str(out.with_suffix(".new.jpg"))],
            capture_output=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        if r.returncode == 0:
            os.replace(out.with_suffix(".new.jpg"), out)
        else:
            os.replace(tmp, out)
    except FileNotFoundError:  # no ffmpeg: browsers sniff the real image type anyway
        os.replace(tmp, out)
    finally:
        tmp.unlink(missing_ok=True)
    song.update(thumb=True, customThumb=True, thumbVer=int(now() * 1000))
    lib.save()
    return jsonify(song)


@app.delete("/api/songs/<sid>/thumb")
def reset_thumb(sid):
    """Go back to the original YouTube artwork."""
    song = lib.songs.get(sid) or abort(404)
    path = THUMB_DIR / f"{sid}.jpg"
    if song["source"] == "youtube":
        song["thumb"] = fetch_thumb(sid) or (path.exists() and not song.get("customThumb"))
    else:
        parent = THUMB_DIR / f"{song.get('parent')}.jpg"
        if parent.exists():
            shutil.copy(parent, path)
            song["thumb"] = True
        else:
            path.unlink(missing_ok=True)
            song["thumb"] = False
    if not song["thumb"]:
        path.unlink(missing_ok=True)
    song.update(customThumb=False, thumbVer=int(now() * 1000))
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
        if "hidden" in body:
            pl["hidden"] = bool(body["hidden"])
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
        target=render_edit, args=(new_id, AUDIO_DIR / src["file"], segs, edit_opts(body)), daemon=True,
    ).start()
    return jsonify(song)


def wav_duration(path: Path) -> float:
    """Length of a PCM / float WAV (Python's wave module can't read float WAVs)."""
    import struct
    with open(path, "rb") as fh:
        head = fh.read(12)
        if head[:4] != b"RIFF" or head[8:12] != b"WAVE":
            raise ValueError("not a WAV file")
        rate = block = 0
        while True:
            chunk = fh.read(8)
            if len(chunk) < 8:
                raise ValueError("WAV has no audio data")
            cid, size = chunk[:4], struct.unpack("<I", chunk[4:])[0]
            if cid == b"fmt ":
                fmt = fh.read(size)
                rate, block = struct.unpack("<I", fmt[4:8])[0], struct.unpack("<H", fmt[12:14])[0]
            elif cid == b"data":
                return size / (rate * block) if rate and block else 0.0
            else:
                fh.seek(size + (size & 1), 1)


@app.post("/api/edit/upload")
def edit_upload():
    """Save an edit that was finished in the browser (16D binaural render) as a new song."""
    src = lib.songs.get(request.form.get("source", "")) or abort(404)
    f = request.files.get("audio")
    if not f:
        return jsonify({"error": "No audio received"}), 400
    new_id = "edit-" + uuid.uuid4().hex[:8]
    title = (request.form.get("title") or f"{src['title']} (16D)").strip()[:120]
    tmp = AUDIO_DIR / f"{new_id}.upload.wav"
    f.save(tmp)
    out = AUDIO_DIR / f"{new_id}.m4a"
    try:
        duration = wav_duration(tmp)
        loud = request.form.get("loud", "off")
        try:
            gain = max(-18.0, min(18.0, float(request.form.get("gain", 0) or 0)))
        except ValueError:
            gain = 0.0
        finalize(tmp, out, loud if loud in LOUDNESS else "off", ref=AUDIO_DIR / src["file"], gain_db=gain)
    except Exception as e:
        out.unlink(missing_ok=True)
        return jsonify({"error": f"Saving failed: {e}"}), 500
    finally:
        tmp.unlink(missing_ok=True)
    song = new_song(new_id, src["url"], title)
    song.update(artist=src.get("artist", ""), source="edit", parent=src["id"], status="ready", progress=100,
                file=out.name, duration=round(duration, 2), thumb=src.get("thumb", False))
    if src.get("thumb"):
        shutil.copy(THUMB_DIR / f"{src['id']}.jpg", THUMB_DIR / f"{new_id}.jpg")
    with lib.lock:
        lib.songs[new_id] = song
        lib.save()
    return jsonify(song)


def edit_opts(body: dict) -> dict:
    return {
        "pitch": body.get("pitch", "vinyl"),
        "fadeIn": float(body.get("fadeIn", 0) or 0),
        "fadeOut": float(body.get("fadeOut", 0) or 0),
        "reverb": body.get("reverb") if body.get("reverb") in REVERBS else None,
        "semitones": float(body.get("semitones", 0) or 0),
        "reverbAmount": float(body.get("reverbAmount", 0.7) or 0),
        "eightD": body.get("eightD") if body.get("eightD") in ("off", "all", "parts") else "off",
        "eightDPeriod": float(body.get("eightDPeriod", 8) or 8),
        "warm": bool(body.get("warm")),
        "fx": clean_fx(body.get("fx")),
    }


preview_lock = threading.Lock()


@app.post("/api/preview")
def preview():
    """Render the edit at full quality (same engine as Save) for listening."""
    body = request.json or {}
    src = lib.songs.get(body.get("source")) or abort(404)
    segs = [s for s in body.get("segments", []) if float(s["end"]) - float(s["start"]) > 0.01]
    if not segs:
        return jsonify({"error": "Nothing left to play — every part was cut."}), 400
    cache = DATA_DIR / "cache"
    cache.mkdir(exist_ok=True)
    # "wav" = lossless 32-bit float, used as the in-between step for the 16D stage in the browser
    ext = "wav" if body.get("format") == "wav" else "m4a"
    with preview_lock:
        try:
            total = run_render(AUDIO_DIR / src["file"], segs, edit_opts(body), cache / f"preview.{ext}",
                               match=ext != "wav")
        except Exception as e:
            return jsonify({"error": f"Preview failed: {e}"}), 500
    return jsonify({"url": f"/media/preview?fmt={ext}&v={int(now() * 1000)}", "duration": total})


@app.get("/media/preview")
def preview_file():
    ext = "wav" if request.args.get("fmt") == "wav" else "m4a"
    path = DATA_DIR / "cache" / f"preview.{ext}"
    if not path.exists():
        abort(404)
    return send_file(path, conditional=True, max_age=0)


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
