"""AI clip selection and social copywriting with Gemini, Groq or Claude.

The service is picked from whichever key is set in Settings (Gemini, then Groq, then Anthropic),
or with VIRALCUT_PROVIDER. Falls back to the offline heuristics in analysis.py when none is set.
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
import urllib.error
import urllib.request

from pydantic import BaseModel, Field

from .transcript import Sentence, transcript_text

log = logging.getLogger(__name__)

DEFAULT_MODELS = {"gemini": "gemini-flash-latest", "groq": "llama-3.3-70b-versatile", "anthropic": "claude-opus-5-5"}
LABELS = {"gemini": "Gemini", "groq": "Groq", "anthropic": "Claude"}
KEYS = {"gemini": "GEMINI_API_KEY", "groq": "GROQ_API_KEY", "anthropic": "ANTHROPIC_API_KEY"}
GEMINI_FALLBACKS = ["gemini-flash-latest", "gemini-2.5-flash", "gemini-flash-lite-latest", "gemini-2.5-flash-lite"]
PLATFORMS = ("youtube", "instagram", "facebook", "x", "linkedin")


class PlatformPosts(BaseModel):
    youtube: str = Field("", description="YouTube Shorts title, <70 chars, curiosity-driven; no hashtags")
    instagram: str = Field("", description="Instagram Reels caption: hook line, 2-3 short lines of value, CTA; no hashtags")
    facebook: str = Field("", description="Facebook post: friendly, 2-3 sentences that invite comments; no hashtags")
    x: str = Field("", description="X/Twitter post, <260 chars; no hashtags")
    linkedin: str = Field("", description="LinkedIn post: hook, 3-5 short lines with a takeaway, question at end")


class PlatformHashtags(BaseModel):
    youtube: list[str] = Field(default_factory=list)
    instagram: list[str] = Field(default_factory=list)
    facebook: list[str] = Field(default_factory=list)
    x: list[str] = Field(default_factory=list)
    linkedin: list[str] = Field(default_factory=list)


class ClipPlan(BaseModel):
    start: float = Field(description="clip start in seconds, at the start of a sentence")
    end: float = Field(description="clip end in seconds, at the end of a sentence")
    title: str = Field("", description="scroll-stopping title for the clip")
    hook: str = Field("", description="on-screen hook text for the first 3 seconds, max 7 words, ALL CAPS")
    virality_score: int = Field(0, description="0-100 predicted virality")
    reason: str = Field("", description="one sentence on why this moment will perform")
    posts: PlatformPosts = Field(default_factory=PlatformPosts)
    hashtags: PlatformHashtags = Field(default_factory=PlatformHashtags)


class ClipPlans(BaseModel):
    clips: list[ClipPlan]
    video_summary: str = Field("", description="one-paragraph summary of the whole video")
    long_form_post: str = Field("", description="a standalone viral text post / thread opener promoting the full video")


SYSTEM = """You are a top short-form video editor and social media strategist who has grown \
channels to millions of followers by clipping podcasts, interviews, streams and talks.

From a timestamped transcript you pick the moments most likely to go viral as standalone \
9:16 shorts on YouTube Shorts, Instagram Reels and Facebook Reels, and you write the copy to post them.

What makes a great clip:
- The first 3 seconds hook the viewer: a bold claim, a question, a surprising number, conflict, or emotion.
- It stands alone: a viewer with no context understands it and gets a payoff (insight, laugh, twist, story resolution).
- It starts at the beginning of a sentence and ends on a complete thought - never mid-sentence.
- High energy, strong opinions, stories and controversy beat generic small talk, intros and sponsor reads.
- Clips must not overlap each other.

Hashtags: 5-10 per platform for YouTube, Instagram and Facebook, each starting with '#', mixing 2-3 broad \
discovery tags with specific niche/topic tags from the content. LinkedIn and X get 2-4 professional tags.
Write in the transcript's language. Make the copy sound human and native to each platform."""

SHAPE = """Reply with ONLY one JSON object (no markdown, no commentary) in exactly this shape:
{"clips": [{"start": 83, "end": 131, "title": "...", "hook": "...", "virality_score": 0, "reason": "...",
  "posts": {"youtube": "...", "instagram": "...", "facebook": "...", "x": "...", "linkedin": "..."},
  "hashtags": {"youtube": ["#..."], "instagram": ["#..."], "facebook": ["#..."], "x": ["#..."], "linkedin": ["#..."]}}],
 "video_summary": "...", "long_form_post": "..."}
start and end are in seconds."""


def provider() -> tuple[str, str, str] | None:
    """(name, model, key) for the service to use, or None."""
    forced = os.environ.get("VIRALCUT_PROVIDER", "").lower()
    order = [forced] if forced in KEYS else ["gemini", "groq", "anthropic"]
    for name in order:
        key = os.environ.get(KEYS[name]) or (os.environ.get("GOOGLE_API_KEY") if name == "gemini" else None)
        if name == "anthropic":
            key = key or os.environ.get("ANTHROPIC_AUTH_TOKEN")
        if key:
            return name, os.environ.get("VIRALCUT_MODEL") or DEFAULT_MODELS[name], key
    return None


def available() -> bool:
    return provider() is not None


def describe() -> str:
    p = provider()
    return f"{LABELS[p[0]]} ({p[1]})" if p else "offline"


def _post_json(url: str, body: dict, headers: dict, timeout: int = 300) -> tuple[int, dict | str]:
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json", **headers})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # nosec B310 - fixed https API endpoints
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as err:
        return err.code, err.read().decode(errors="replace")


def _extract_json(text: str) -> dict:
    text = text.strip()
    fenced = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
    if fenced:
        text = fenced.group(1)
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise RuntimeError("the AI returned no JSON")
    return json.loads(text[start : end + 1])


def _gemini(model: str, key: str, prompt: str) -> str:
    body = {
        "systemInstruction": {"parts": [{"text": SYSTEM}]},
        "contents": [{"role": "user", "parts": [{"text": f"{prompt}\n\n{SHAPE}"}]}],
        "generationConfig": {"responseMimeType": "application/json", "maxOutputTokens": 32768, "temperature": 0.7},
    }
    last = ""
    for m in [model] + [x for x in GEMINI_FALLBACKS if x != model]:
        for attempt in range(2):
            status, data = _post_json(
                f"https://generativelanguage.googleapis.com/v1beta/models/{m}:generateContent", body, {"x-goog-api-key": key}
            )
            if status == 200 and isinstance(data, dict):
                parts = (data.get("candidates") or [{}])[0].get("content", {}).get("parts", [])
                text = "".join(p.get("text", "") for p in parts if not p.get("thought"))
                if text:
                    return text
                last = "Gemini returned an empty answer"
                break
            last = f"Gemini error {status}: {str(data)[:200]}"
            if status in (400, 401, 403):
                raise RuntimeError("your Gemini API key is invalid" if "API key" in str(data) else last)
            if status == 429 and attempt == 0:
                wait = re.search(r'"retryDelay":\s*"(\d+)', str(data))
                if wait and int(wait.group(1)) <= 35:
                    time.sleep(int(wait.group(1)) + 1)
                    continue
            if status not in (500, 502, 503, 504):
                break
            time.sleep(2)
    raise RuntimeError(last or "Gemini is unavailable")


def _groq(model: str, key: str, prompt: str) -> str:
    status, data = _post_json(
        "https://api.groq.com/openai/v1/chat/completions",
        {
            "model": model,
            "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": f"{prompt}\n\n{SHAPE}"}],
            "response_format": {"type": "json_object"},
            "temperature": 0.7,
            "max_completion_tokens": 16000,
        },
        {"Authorization": f"Bearer {key}"},
    )
    if status != 200 or not isinstance(data, dict):
        if status == 401:
            raise RuntimeError("your Groq API key is invalid")
        if status in (413, 429):
            raise RuntimeError("Groq's free limit was reached or the video is too long; use a Gemini key for long videos")
        raise RuntimeError(f"Groq error {status}: {str(data)[:200]}")
    return data["choices"][0]["message"]["content"]


def _claude(model: str, key: str, prompt: str) -> ClipPlans:
    import anthropic  # pylint: disable=import-outside-toplevel

    client = anthropic.Anthropic(api_key=key) if key.startswith("sk-ant-") else anthropic.Anthropic()
    response = client.beta.messages.parse(
        model=model,
        max_tokens=16000,
        system=SYSTEM,
        messages=[{"role": "user", "content": prompt}],
        output_format=ClipPlans,
        output_config={"effort": "high"},
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
    )
    if response.stop_reason == "refusal":
        raise RuntimeError("Claude declined to process this transcript")
    if response.parsed_output is None:
        raise RuntimeError(f"Claude returned no structured output (stop_reason={response.stop_reason})")
    return response.parsed_output


def plan_clips(sentences: list[Sentence], count: int, min_len: float, max_len: float,
               hints: list[dict], source_title: str = "") -> ClipPlans:
    """Ask the configured AI service for the best clips plus per-platform posts and hashtags."""
    p = provider()
    if p is None:
        raise RuntimeError("no AI key is set")
    name, model, key = p
    hint_lines = "\n".join(
        f"- {h['start']:.1f}-{h['end']:.1f}s (score {h['score']}, signals {h['signals']})" for h in hints
    )
    prompt = (
        f"Video title: {source_title or 'unknown'}\n\n"
        f"<transcript>\n{transcript_text(sentences, with_times=True)}\n</transcript>\n\n"
        f"Pick the {count} best clips, each between {min_len:.0f} and {max_len:.0f} seconds long. "
        "Use the transcript timestamps for start and end.\n\n"
        "An acoustic/linguistic pre-scorer flagged these windows (use them as hints, not rules):\n"
        f"{hint_lines or '- none'}"
    )
    if name == "anthropic":
        return _claude(model, key, prompt)
    text = _gemini(model, key, prompt) if name == "gemini" else _groq(model, key, prompt)
    data = _extract_json(text)
    for clip in data.get("clips", []):
        for field in ("start", "end"):
            value = clip.get(field)
            if isinstance(value, str) and ":" in value:  # "1:23" -> 83
                parts = [float(x) for x in value.split(":")]
                clip[field] = sum(v * 60 ** i for i, v in enumerate(reversed(parts)))
    return ClipPlans.model_validate(data)


def snap_to_sentences(start: float, end: float, sentences: list[Sentence],
                      min_len: float, max_len: float) -> tuple[float, float, list[Sentence]]:
    """Align a proposed clip to sentence boundaries and the allowed length."""
    if not sentences:
        return start, end, []
    first = min(range(len(sentences)), key=lambda i: abs(sentences[i].start - start))
    last = min(range(first, len(sentences)), key=lambda i: abs(sentences[i].end - end))
    while last > first and sentences[last].end - sentences[first].start > max_len:
        last -= 1
    while last + 1 < len(sentences) and sentences[last].end - sentences[first].start < min_len:
        last += 1
    group = sentences[first : last + 1]
    return group[0].start, group[-1].end, group
