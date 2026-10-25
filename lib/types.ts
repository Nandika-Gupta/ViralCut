export type Word = { text: string; start: number; end: number };
export type Sentence = { text: string; start: number; end: number; words: Word[] };

export const PLATFORMS = ["tiktok", "instagram", "youtube", "x", "linkedin", "facebook"] as const;
export type Platform = (typeof PLATFORMS)[number];
export const PLATFORM_LABELS: Record<Platform, string> = {
  tiktok: "TikTok",
  instagram: "Reels",
  youtube: "Shorts",
  x: "X",
  linkedin: "LinkedIn",
  facebook: "Facebook",
};

export type ClipPlan = {
  start: number;
  end: number;
  title: string;
  hook: string;
  quote: string;
  why: string;
  virality: number;
  posts: Partial<Record<Platform, string>>;
  hashtags: Partial<Record<Platform, string[]>>;
};

export type Plan = {
  title: string;
  summary: string;
  clips: ClipPlan[];
  full_video: { x_thread: string[]; linkedin: string; instagram: string };
  hashtag_bank: { broad: string[]; niche: string[] };
  engine: string;
};

export type ClipRequest = {
  transcript: string; // "[m:ss] text" lines
  title: string;
  count: number;
  minLen: number;
  maxLen: number;
  platforms: Platform[];
  tone: string;
  language: string;
};

export type PostsRequest = {
  title: string;
  clip: { title: string; hook: string; text: string };
  platforms: Platform[];
  tone: string;
  language: string;
};
