"use client";

import { useState } from "react";

import { PLATFORM_ICONS } from "./icons";
import { formatTime } from "@/lib/transcript";
import { PLATFORM_LABELS, type ClipPlan, type Platform } from "@/lib/types";

export type RenderState = { status: "queued" | "rendering" | "done" | "error"; progress: number; url?: string; ext?: string; thumb?: string; error?: string };

type Props = {
  index: number;
  clip: ClipPlan;
  platforms: Platform[];
  videoId?: string;
  render?: RenderState;
  onCopy: (text: string) => void;
  onSchedule: (clip: ClipPlan, platform: Platform) => void;
  fileName: string;
};

const scoreClass = (s: number) => (s >= 85 ? "hot" : s >= 70 ? "good" : "ok");

export default function ClipCard({ index, clip, platforms, videoId, render, onCopy, onSchedule, fileName }: Props) {
  const [platform, setPlatform] = useState<Platform>(platforms[0]);
  const [playing, setPlaying] = useState(false);
  const text = clip.posts[platform] ?? "";
  const tags = clip.hashtags[platform] ?? [];
  const full = `${text}\n\n${tags.join(" ")}`.trim();
  const duration = Math.round(clip.end - clip.start);

  let screen;
  if (render?.status === "done" && render.url) {
    screen = <video src={render.url} poster={render.thumb} controls playsInline preload="metadata" />;
  } else if (render && render.status !== "error") {
    screen = (
      <>
        {render.thumb ? <img src={render.thumb} alt="" /> : <div className="placeholder">{render.status === "queued" ? "Waiting to render…" : "Rendering…"}</div>}
        <div className="render-overlay">
          <span>{render.status === "queued" ? "In the queue" : `Rendering 9:16 short · ${Math.round(render.progress * 100)}%`}</span>
          <div className={`bar${render.status === "queued" ? " indeterminate" : ""}`}><i style={{ width: `${Math.round(render.progress * 100)}%` }} /></div>
        </div>
      </>
    );
  } else if (videoId && playing) {
    const src = `https://www.youtube.com/embed/${videoId}?start=${Math.floor(clip.start)}&end=${Math.ceil(clip.end)}&autoplay=1&rel=0&playsinline=1`;
    screen = <iframe src={src} title={clip.title} allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen />;
  } else if (videoId) {
    screen = (
      <button type="button" className="yt-thumb" onClick={() => setPlaying(true)} aria-label={`Play ${clip.title}`}>
        <img src={`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.visibility = "hidden"; }} />
        <span className="hook-preview">{clip.hook}</span>
        <span className="play">▶</span>
        <span className="play-note">Preview this moment</span>
      </button>
    );
  } else {
    screen = <div className="placeholder">{render?.error ?? "Add the video file to render this short."}</div>;
  }

  return (
    <article className="clip" id={`clip-${index}`}>
      <div className="screen">
        <span className={`badge ${scoreClass(clip.virality)}`} title="Predicted virality">🔥 {clip.virality}</span>
        <span className="dur">{duration}s · {formatTime(clip.start)}</span>
        {screen}
      </div>
      <div className="clip-body">
        <h3>#{index + 1} {clip.title}</h3>
        {clip.hook && <span className="hook-tag">{clip.hook}</span>}
        {clip.why && <p className="why">{clip.why}</p>}
        {clip.quote && <blockquote>“{clip.quote.replace(/^["“]|["”]$/g, "")}”</blockquote>}
        <div className="tabs" role="tablist">
          {platforms.map((p) => {
            const Icon = PLATFORM_ICONS[p];
            return (
              <button key={p} type="button" role="tab" className="tab" aria-selected={p === platform} onClick={() => setPlatform(p)}>
                <Icon size={14} /> {PLATFORM_LABELS[p]}
              </button>
            );
          })}
        </div>
        <div className="post-box">
          <p className="post-text">{text || "No post written for this platform."}</p>
          {tags.length > 0 && <div className="tags">{tags.map((t) => <span key={t}>{t}</span>)}</div>}
          <div className="row">
            <button type="button" className="btn small" onClick={() => onCopy(full)}>Copy post + hashtags</button>
            <button type="button" className="btn small ghost" onClick={() => onCopy(tags.join(" "))}>Copy hashtags</button>
          </div>
        </div>
      </div>
      <div className="clip-foot">
        {render?.status === "done" && render.url ? (
          <a className="btn" href={render.url} download={`${fileName}.${render.ext}`}>⬇ Download</a>
        ) : videoId ? (
          <a className="btn" href={`https://www.youtube.com/watch?v=${videoId}&t=${Math.floor(clip.start)}s`} target="_blank" rel="noopener noreferrer">▶ Open on YouTube</a>
        ) : (
          <button className="btn" type="button" disabled>⬇ Download</button>
        )}
        <button className="btn primary" type="button" onClick={() => onSchedule(clip, platform)}>🗓 Schedule</button>
      </div>
    </article>
  );
}
