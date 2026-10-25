export type ScheduledPost = { id: string; clipTitle: string; platform: string; time: string; caption: string };

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/** Calendar file with one 15-minute reminder per scheduled post. */
export function buildIcs(posts: ScheduledPost[]): string {
  const now = stamp(new Date());
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ViralCut//Posting Schedule//EN", "CALSCALE:GREGORIAN"];
  for (const p of posts) {
    const start = new Date(p.time);
    lines.push(
      "BEGIN:VEVENT", `UID:${p.id}@viralcut`, `DTSTAMP:${now}`, `DTSTART:${stamp(start)}`,
      `DTEND:${stamp(new Date(start.getTime() + 15 * 60000))}`,
      `SUMMARY:${esc(`Post on ${p.platform}: ${p.clipTitle}`)}`, `DESCRIPTION:${esc(p.caption)}`,
      "BEGIN:VALARM", "TRIGGER:-PT10M", "ACTION:DISPLAY", "DESCRIPTION:Time to post your short", "END:VALARM", "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

/** Typical engagement peaks (local time): hour, minute, preferred weekdays (0 = Sunday). */
const BEST: Record<string, [number, number, number[]]> = {
  instagram: [11, 0, [1, 3, 5]], youtube: [15, 0, [4, 5, 6]],
  x: [9, 0, [2, 3, 4]], linkedin: [8, 30, [2, 3, 4]], facebook: [13, 0, [3, 4, 5]],
};

export function nextBestTime(platform: string, from = new Date()): Date {
  const [h, m, days] = BEST[platform] ?? [18, 0, [1, 2, 3, 4, 5]];
  for (let i = 0; i < 8; i++) {
    const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i, h, m);
    if (d > from && days.includes(d.getDay())) return d;
  }
  return new Date(from.getTime() + 86400000);
}
