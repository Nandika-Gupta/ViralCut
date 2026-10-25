"use client";

import { useEffect, useState } from "react";

import type { Project } from "./Studio";
import { formatTime } from "@/lib/transcript";

/** A delete button that asks "Sure?" in place before acting (no browser pop-ups). */
export function ConfirmButton({ label, confirmLabel, onConfirm, className = "btn small ghost" }: { label: string; confirmLabel: string; onConfirm: () => void; className?: string }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = window.setTimeout(() => setArmed(false), 4000);
    return () => window.clearTimeout(t);
  }, [armed]);
  return (
    <button type="button" className={`${className}${armed ? " danger" : ""}`} onClick={() => (armed ? onConfirm() : setArmed(true))}>
      {armed ? confirmLabel : label}
    </button>
  );
}

/** Title of the open project with Rename and Delete. */
export function ProjectTitle({ title, onRename, onDelete }: { title: string; onRename: (t: string) => void; onDelete: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  useEffect(() => setDraft(title), [title]);
  if (editing) {
    return (
      <form className="title-edit" onSubmit={(e) => { e.preventDefault(); onRename(draft); setEditing(false); }}>
        <input className="field" value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Project name" autoFocus maxLength={120} />
        <button className="btn small primary" type="submit">Save</button>
        <button className="btn small ghost" type="button" onClick={() => { setDraft(title); setEditing(false); }}>Cancel</button>
      </form>
    );
  }
  return (
    <div className="title-row">
      <h2>{title}</h2>
      <div className="row">
        <button type="button" className="btn small ghost" onClick={() => setEditing(true)}>✏️ Rename</button>
        <ConfirmButton label="🗑 Delete project" confirmLabel="Click again to delete" onConfirm={onDelete} />
      </div>
    </div>
  );
}

type PanelProps = {
  projects: Project[];
  openId?: string;
  onOpen: (p: Project) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onDeleteAll: () => void;
};

export default function ProjectsPanel({ projects, openId, onOpen, onRename, onDelete, onDeleteAll }: PanelProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const shown = projects.filter((p) => p.title.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <section className="panel projects" id="projects" style={{ marginTop: 26 }}>
      <div className="projects-head">
        <div>
          <h3 style={{ margin: 0 }}>📁 My projects</h3>
          <p className="muted" style={{ margin: "4px 0 0", fontSize: 13.5 }}>Saved in this browser. Open one to keep editing, creating and publishing its shorts.</p>
        </div>
        <div className="row">
          {projects.length > 4 && <input className="field" style={{ width: 200 }} placeholder="Search projects…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search projects" />}
          <ConfirmButton label="Delete all" confirmLabel="Click again to delete all" onConfirm={onDeleteAll} />
        </div>
      </div>
      <ul className="project-list">
        {shown.map((p) => {
          const vid = p.source.kind === "youtube" ? p.source.videoId : "";
          return (
            <li key={p.id} className={p.id === openId ? "open" : ""}>
              <button type="button" className="project-thumb" onClick={() => onOpen(p)} aria-label={`Open ${p.title}`}>
                {vid ? <img src={`https://i.ytimg.com/vi/${vid}/mqdefault.jpg`} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.visibility = "hidden"; }} /> : <span>🎬</span>}
              </button>
              <div className="project-info">
                {editingId === p.id ? (
                  <form className="title-edit" onSubmit={(e) => { e.preventDefault(); onRename(p.id, draft); setEditingId(null); }}>
                    <input className="field" value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Project name" autoFocus maxLength={120} />
                    <button className="btn small primary" type="submit">Save</button>
                    <button className="btn small ghost" type="button" onClick={() => setEditingId(null)}>Cancel</button>
                  </form>
                ) : (
                  <b title={p.title}>{p.title}</b>
                )}
                <span className="muted">
                  {new Date(p.created).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" })} · {p.plan.clips.length} {p.plan.clips.length === 1 ? "clip" : "clips"} ·{" "}
                  {p.duration ? `${formatTime(p.duration)} video` : ""} · {p.source.kind === "youtube" ? "YouTube link" : p.source.name}
                </span>
              </div>
              <div className="row project-actions">
                <button type="button" className="btn small" onClick={() => onOpen(p)}>{p.id === openId ? "Open ✓" : "Open"}</button>
                <button type="button" className="btn small ghost" onClick={() => { setEditingId(p.id); setDraft(p.title); }}>Rename</button>
                <ConfirmButton label="Delete" confirmLabel="Sure? Delete" onConfirm={() => onDelete(p.id)} />
              </div>
            </li>
          );
        })}
        {!shown.length && <li className="muted">No projects match “{query}”.</li>}
      </ul>
    </section>
  );
}
