"""ViralCut web server.

Run:  uvicorn viralcut.app:app --host 0.0.0.0 --port 8000
"""

from __future__ import annotations

import base64
import hmac
import io
import json
import logging
import os
import re
import shutil
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import hashlib
from urllib.parse import quote, urlparse

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import __version__, ai, config, media
from .pipeline import JobSettings, JobStore

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

DATA_DIR = config.data_dir()
WEB_DIR = Path(__file__).parent / "web"
VIDEO_EXT = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v", ".flv", ".wmv", ".mpeg", ".mpg", ".ts"}
SERVABLE = re.compile(r"^(clip_\d{2}\.(mp4|jpg|ass)|transcript\.(txt|json))$")
PLATFORMS = ("youtube", "instagram", "facebook", "x", "linkedin")

app = FastAPI(title="ViralCut", version=__version__)
store = JobStore(DATA_DIR / "jobs", workers=int(os.environ.get("VIRALCUT_WORKERS", "1")))
app.mount("/static", StaticFiles(directory=WEB_DIR), name="static")
PASSWORD = os.environ.get("VIRALCUT_PASSWORD", "")


@app.middleware("http")
async def require_password(request: Request, call_next):
    """Optional site-wide password (HTTP Basic auth, any username) for public deployments."""
    if not PASSWORD or request.url.path == "/healthz":
        return await call_next(request)
    header = request.headers.get("authorization", "")
    if header.lower().startswith("basic "):
        try:
            _user, _, given = base64.b64decode(header[6:]).decode().partition(":")
        except ValueError:
            given = ""
        if hmac.compare_digest(given.encode(), PASSWORD.encode()):
            return await call_next(request)
    return Response("Password required", status_code=401, headers={"WWW-Authenticate": 'Basic realm="ViralCut"'})


@app.get("/healthz")
def healthz() -> dict:
    return {"ok": True}


def _job_or_404(job_id: str):
    job = store.get(job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    return job


@app.get("/", response_class=HTMLResponse)
def index() -> HTMLResponse:
    return HTMLResponse((WEB_DIR / "index.html").read_text(encoding="utf-8"))


@app.get("/api/config")
def app_config() -> dict:
    try:
        import faster_whisper  # noqa: F401 pylint: disable=import-outside-toplevel,unused-import

        whisper = True
    except ImportError:
        whisper = False
    return {"version": __version__, "ai": ai.available(), "model": ai.describe(), "whisper": whisper,
            "ffmpeg": shutil.which("ffmpeg") is not None}


@app.post("/api/jobs")
async def create_job(
    file: UploadFile | None = File(None),
    url: str = Form(""),
    subtitles: UploadFile | None = File(None),
    settings: str = Form("{}"),
) -> dict:
    url = url.strip()
    if not url and (file is None or not file.filename):
        raise HTTPException(400, "upload a video or paste a link")
    try:
        opts = JobSettings.from_dict(json.loads(settings or "{}"))
    except (ValueError, TypeError) as exc:
        raise HTTPException(400, f"bad settings: {exc}") from exc
    subs_text = None
    if subtitles is not None and subtitles.filename:
        subs_text = (await subtitles.read()).decode("utf-8", errors="replace")

    if url:
        if not url.lower().startswith(("http://", "https://")):
            raise HTTPException(400, "links must start with http:// or https://")
        job = store.create(url, opts)
        store.submit(job, url=url, subtitles=subs_text)
        return job.to_dict()

    ext = Path(file.filename).suffix.lower()
    if ext not in VIDEO_EXT:
        raise HTTPException(400, f"unsupported file type {ext or '(none)'}")
    job = store.create(file.filename, opts)
    dest = store.dir(job.id) / f"source{ext}"
    with dest.open("wb") as fh:
        while chunk := await file.read(8 * 1024 * 1024):
            fh.write(chunk)
    job.title = Path(file.filename).stem.replace("_", " ").replace("-", " ")
    store.submit(job, video_path=dest, subtitles=subs_text)
    return job.to_dict()


@app.get("/api/jobs")
def list_jobs() -> list[dict]:
    return [
        {k: v for k, v in j.to_dict().items() if k in ("id", "title", "status", "progress", "created", "clips", "step")}
        for j in store.all()
    ]


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str) -> dict:
    return _job_or_404(job_id).to_dict()


@app.delete("/api/jobs/{job_id}")
def delete_job(job_id: str) -> dict:
    job = _job_or_404(job_id)
    if job.status == "running":
        raise HTTPException(409, "job is still processing")
    shutil.rmtree(store.dir(job_id), ignore_errors=True)
    store.jobs.pop(job_id, None)
    return {"deleted": job_id}


@app.get("/api/jobs/{job_id}/files/{name}")
def job_file(job_id: str, name: str) -> FileResponse:
    _job_or_404(job_id)
    if not SERVABLE.match(name):
        raise HTTPException(404, "file not found")
    path = store.dir(job_id) / name
    if not path.exists():
        raise HTTPException(404, "file not found")
    return FileResponse(path)


@app.get("/api/jobs/{job_id}/export.zip")
def export_zip(job_id: str) -> StreamingResponse:
    job = _job_or_404(job_id)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as zf:
        for clip in job.clips:
            path = store.dir(job_id) / clip["video"]
            if path.exists():
                zf.write(path, clip["video"])
            lines = [clip["title"], f"Virality score: {clip['score']}", f"Why: {clip['reason']}", ""]
            for p in PLATFORMS:
                lines += [f"== {p.upper()} ==", clip["posts"].get(p, ""), " ".join(clip["hashtags"].get(p, [])), ""]
            zf.writestr(f"{clip['id']}_posts.txt", "\n".join(lines))
        if job.long_form_post:
            zf.writestr("full_video_post.txt", job.long_form_post)
    buf.seek(0)
    return StreamingResponse(buf, media_type="application/zip",
                             headers={"Content-Disposition": f'attachment; filename="viralcut_{job_id}.zip"'})


class SettingsUpdate(BaseModel):
    gemini_api_key: str | None = None
    groq_api_key: str | None = None
    anthropic_api_key: str | None = None
    whisper_model: str | None = None


def _local_only(request: Request) -> None:
    # Settings hold the API keys: only the person sitting at this computer may read or change them.
    host = request.client.host if request.client else ""
    if host not in ("127.0.0.1", "::1", "localhost", "testclient"):
        raise HTTPException(403, "settings can only be changed on the computer running ViralCut")


def _hint(key: str) -> str:
    return f"{key[:6]}…{key[-4:]}" if len(key) > 12 else ""


@app.get("/api/settings")
def get_settings(request: Request) -> dict:
    _local_only(request)
    keys = {name: os.environ.get(env, "") for name, env in
            (("gemini", "GEMINI_API_KEY"), ("groq", "GROQ_API_KEY"), ("anthropic", "ANTHROPIC_API_KEY"))}
    return {
        "keys": {k: {"set": bool(v), "hint": _hint(v)} for k, v in keys.items()},
        "has_key": any(keys.values()),
        "whisper_model": os.environ.get("VIRALCUT_WHISPER_MODEL", "small"),
    }


@app.post("/api/settings")
def update_settings(request: Request, body: SettingsUpdate) -> dict:
    _local_only(request)
    updates = {}
    for field, env, prefix, name in (
        ("gemini_api_key", "GEMINI_API_KEY", "AIza", "Gemini"),
        ("groq_api_key", "GROQ_API_KEY", "gsk_", "Groq"),
        ("anthropic_api_key", "ANTHROPIC_API_KEY", "sk-ant-", "Claude"),
    ):
        value = getattr(body, field)
        if value is None:
            continue
        value = value.strip()
        if value and not value.startswith(prefix):
            raise HTTPException(400, f"{name} API keys start with {prefix}")
        updates[env] = value
    if body.whisper_model is not None:
        if body.whisper_model not in ("tiny", "base", "small", "medium", "large-v3"):
            raise HTTPException(400, "unknown speech model")
        updates["VIRALCUT_WHISPER_MODEL"] = body.whisper_model
    config.save_settings(updates)
    return get_settings(request)


class ScheduleItem(BaseModel):
    clip_id: str
    platform: str
    time: str  # ISO 8601 local datetime from the browser, e.g. 2026-11-01T18:30
    caption: str = ""


@app.post("/api/jobs/{job_id}/schedule")
def add_schedule(job_id: str, item: ScheduleItem) -> list[dict]:
    job = _job_or_404(job_id)
    if item.platform not in PLATFORMS:
        raise HTTPException(400, "unknown platform")
    if not any(c["id"] == item.clip_id for c in job.clips):
        raise HTTPException(400, "unknown clip")
    try:
        datetime.fromisoformat(item.time)
    except ValueError as exc:
        raise HTTPException(400, "time must be ISO 8601") from exc
    job.schedule.append(item.model_dump())
    job.schedule.sort(key=lambda x: x["time"])
    store.save(job)
    return job.schedule


@app.delete("/api/jobs/{job_id}/schedule/{index}")
def remove_schedule(job_id: str, index: int) -> list[dict]:
    job = _job_or_404(job_id)
    if not 0 <= index < len(job.schedule):
        raise HTTPException(404, "no such schedule entry")
    job.schedule.pop(index)
    store.save(job)
    return job.schedule


def _ics_escape(text: str) -> str:
    return text.replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\n", "\\n")


@app.get("/api/jobs/{job_id}/schedule.ics")
def schedule_ics(job_id: str) -> Response:
    job = _job_or_404(job_id)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ViralCut//Posting Schedule//EN"]
    for i, item in enumerate(job.schedule):
        start = datetime.fromisoformat(item["time"])
        clip = next((c for c in job.clips if c["id"] == item["clip_id"]), {"title": item["clip_id"]})
        lines += [
            "BEGIN:VEVENT",
            f"UID:{job_id}-{i}@viralcut",
            f"DTSTAMP:{stamp}",
            f"DTSTART:{start.strftime('%Y%m%dT%H%M%S')}",
            f"DTEND:{(start + timedelta(minutes=15)).strftime('%Y%m%dT%H%M%S')}",
            f"SUMMARY:{_ics_escape('Post on ' + item['platform'].title() + ': ' + clip['title'])}",
            f"DESCRIPTION:{_ics_escape(item.get('caption', ''))}",
            "BEGIN:VALARM", "TRIGGER:-PT10M", "ACTION:DISPLAY", "DESCRIPTION:Time to post your short", "END:VALARM",
            "END:VEVENT",
        ]
    lines.append("END:VCALENDAR")
    return Response("\r\n".join(lines) + "\r\n", media_type="text/calendar",
                    headers={"Content-Disposition": f'attachment; filename="schedule_{job_id}.ics"'})


# ---------------------------------------------------------------------------
# Helper for the ViralCut website: YouTube blocks cloud servers, so the website asks the app running on the
# user's own computer to download the video, then creates the shorts in the browser.
# ---------------------------------------------------------------------------

WEB_ORIGINS = os.environ.get(
    "VIRALCUT_WEB_ORIGINS", r"https://([a-z0-9-]+\.)*vercel\.app|http://localhost(:\d+)?|http://127\.0\.0\.1(:\d+)?"
)
HELPER_HOSTS = re.compile(
    r"(^|\.)(youtube\.com|youtu\.be|twitch\.tv|kick\.com|vimeo\.com|x\.com|twitter\.com|loom\.com|dropbox\.com"
    r"|drive\.google\.com|facebook\.com|fb\.watch|instagram\.com)$"
)
app.add_middleware(
    CORSMiddleware, allow_origin_regex=WEB_ORIGINS, allow_methods=["GET", "POST", "OPTIONS"], allow_headers=["*"],
    expose_headers=["Content-Length", "X-Video-Title"], max_age=600,
)


@app.middleware("http")
async def private_network_access(request: Request, call_next):
    """Chrome asks before a public website may talk to an app on this computer; this header says the app agrees."""
    response = await call_next(request)
    if request.headers.get("access-control-request-private-network"):
        response.headers["Access-Control-Allow-Private-Network"] = "true"
    return response


@app.get("/api/helper/ping")
def helper_ping() -> dict:
    return {"app": "viralcut-helper", "version": __version__}


class HelperDownload(BaseModel):
    url: str


@app.post("/api/helper/download")
def helper_download(body: HelperDownload) -> FileResponse:
    url = body.url.strip()
    host = (urlparse(url).hostname or "").lower()
    if not url.lower().startswith(("http://", "https://")) or not HELPER_HOSTS.search(host):
        raise HTTPException(400, "Only video links from YouTube, Instagram, Facebook, X, Twitch, Kick, Vimeo, Loom, Dropbox or Drive")
    root = DATA_DIR / "downloads"
    folder = root / hashlib.sha1(url.encode()).hexdigest()[:16]
    cached = sorted(folder.glob("source.*"), key=lambda p: p.stat().st_size, reverse=True) if folder.exists() else []
    if cached and cached[0].suffix != ".part":
        path = cached[0]
    else:
        folder.mkdir(parents=True, exist_ok=True)
        try:
            path = media.download(url, folder, max_height=720)
        except Exception as exc:  # pylint: disable=broad-except
            shutil.rmtree(folder, ignore_errors=True)
            message = str(exc).replace("ERROR: ", "")[:300]
            raise HTTPException(502, f"Couldn't download this video: {message}") from exc
        # keep only the 5 most recent downloads
        for old in sorted(root.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True)[5:]:
            shutil.rmtree(old, ignore_errors=True)
    title_file = folder / "source_title.txt"
    title = title_file.read_text(encoding="utf-8") if title_file.exists() else ""
    return FileResponse(path, media_type="video/mp4", filename=f"video{path.suffix}", headers={"X-Video-Title": quote(title)})
