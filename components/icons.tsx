import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number };
const base = (size = 20, props: P) => ({ width: size, height: size, viewBox: "0 0 24 24", "aria-hidden": true, ...props });

export const YouTube = ({ size, ...p }: P) => (
  <svg {...base(size, p)}><rect x="1.5" y="5" width="21" height="14" rx="4" fill="#FF0033" /><path d="M10 9.2v5.6l5-2.8z" fill="#fff" /></svg>
);
export const Instagram = ({ size, ...p }: P) => (
  <svg {...base(size, p)}>
    <defs><linearGradient id="ig" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stopColor="#FEDA75" /><stop offset=".35" stopColor="#FA7E1E" /><stop offset=".6" stopColor="#D62976" /><stop offset="1" stopColor="#4F5BD5" /></linearGradient></defs>
    <rect x="2" y="2" width="20" height="20" rx="6" fill="url(#ig)" /><rect x="6.5" y="6.5" width="11" height="11" rx="3.5" fill="none" stroke="#fff" strokeWidth="1.8" /><circle cx="12" cy="12" r="2.6" fill="none" stroke="#fff" strokeWidth="1.8" /><circle cx="16.6" cy="7.4" r="1" fill="#fff" />
  </svg>
);
export const XLogo = ({ size, ...p }: P) => (
  <svg {...base(size, p)}><rect width="24" height="24" rx="6" fill="#111" /><path d="M6.5 6h3.2l2.6 3.6L15.4 6h2l-4.2 4.8L18 18h-3.2l-2.9-4-3.5 4h-2l4.6-5.2z" fill="#fff" /></svg>
);
export const LinkedIn = ({ size, ...p }: P) => (
  <svg {...base(size, p)}><rect width="24" height="24" rx="5" fill="#0A66C2" /><path d="M7 10h2.4v7.5H7zm1.2-3.9a1.4 1.4 0 1 1 0 2.8 1.4 1.4 0 0 1 0-2.8zM11 10h2.3v1c.4-.7 1.3-1.2 2.5-1.2 2.4 0 2.8 1.5 2.8 3.5v4.2h-2.4v-3.7c0-.9 0-2-1.2-2s-1.5.9-1.5 1.9v3.8H11z" fill="#fff" /></svg>
);
export const Facebook = ({ size, ...p }: P) => (
  <svg {...base(size, p)}><circle cx="12" cy="12" r="11" fill="#0866FF" /><path d="M13.2 19.5v-5.6h1.9l.3-2.3h-2.2v-1.5c0-.6.2-1.1 1.1-1.1h1.2V7c-.2 0-.9-.1-1.8-.1-1.8 0-3 1.1-3 3.1v1.7H8.8v2.3h1.9v5.6z" fill="#fff" /></svg>
);
export const Twitch = ({ size, ...p }: P) => (
  <svg {...base(size, p)}><rect width="24" height="24" rx="6" fill="#9146FF" /><path d="M7 5 6 7.6V18h3v2h2l2-2h2.5L19 14.5V5zm10.5 9-2 2H13l-2 2v-2H8.5V6.5h9zM15 8.5h1.5v4H15zm-4 0h1.5v4H11z" fill="#fff" /></svg>
);
export const Kick = ({ size, ...p }: P) => (
  <svg {...base(size, p)}><rect width="24" height="24" rx="6" fill="#0b0e0f" /><path d="M6 5h4v4h2V7h2V5h4v5h-2v2h-2v0h2v2h2v5h-4v-2h-2v-2h-2v4H6z" fill="#53FC18" /></svg>
);
export const Drive = ({ size, ...p }: P) => (
  <svg {...base(size, p)}><path d="M8.3 3h7.4l6.1 10.6h-7.4z" fill="#FFBA00" /><path d="M2.2 13.6 5.9 20h12.2l3.7-6.4z" fill="#2684FC" /><path d="M8.3 3 2.2 13.6 5.9 20l6.1-10.6z" fill="#00AC47" /></svg>
);
export const Dropbox = ({ size, ...p }: P) => (
  <svg {...base(size, p)}><path d="m7 3 5 3.2-5 3.2-5-3.2zm10 0 5 3.2-5 3.2-5-3.2zM2 12.6l5-3.2 5 3.2-5 3.2zm15-3.2 5 3.2-5 3.2-5-3.2zM7 17l5-3.2 5 3.2-5 3.2z" fill="#0061FF" /></svg>
);
export const Loom = ({ size, ...p }: P) => (
  <svg {...base(size, p)}><circle cx="12" cy="12" r="11" fill="#625DF5" /><circle cx="12" cy="12" r="3" fill="#fff" />{[0, 45, 90, 135].map((a) => <rect key={a} x="11" y="3.5" width="2" height="17" rx="1" fill="#fff" opacity=".85" transform={`rotate(${a} 12 12)`} />)}<circle cx="12" cy="12" r="3.2" fill="#625DF5" /><circle cx="12" cy="12" r="2" fill="#fff" /></svg>
);
export const Discord = ({ size, ...p }: P) => (
  <svg {...base(size, p)}><circle cx="12" cy="12" r="11" fill="#5865F2" /><path d="M16.6 8.2a11 11 0 0 0-2.7-.8l-.3.6a10 10 0 0 0-3.2 0l-.3-.6a11 11 0 0 0-2.7.8C5.7 10.7 5.3 13.1 5.5 15.5a11 11 0 0 0 3.3 1.6l.7-1.1-1.1-.6.3-.2a7.8 7.8 0 0 0 6.6 0l.3.2-1.1.6.7 1.1a11 11 0 0 0 3.3-1.6c.3-2.8-.4-5.2-1.9-7.3zM9.8 14c-.6 0-1.1-.6-1.1-1.3s.5-1.3 1.1-1.3 1.1.6 1.1 1.3-.5 1.3-1.1 1.3zm4.4 0c-.6 0-1.1-.6-1.1-1.3s.5-1.3 1.1-1.3 1.1.6 1.1 1.3-.5 1.3-1.1 1.3z" fill="#fff" /></svg>
);
export const Upload = ({ size = 18, ...p }: P) => (
  <svg {...base(size, p)} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 15V4m0 0L7.5 8.5M12 4l4.5 4.5M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" /></svg>
);
export const Sparkle = ({ size = 16, ...p }: P) => (
  <svg {...base(size, p)} fill="currentColor"><path d="M12 2.5 13.9 9l6.6 2-6.6 2L12 19.5 10.1 13 3.5 11l6.6-2z" /></svg>
);
export const Logo = ({ size = 30, ...p }: P) => (
  <svg {...base(size, p)} viewBox="0 0 32 32">
    <defs><linearGradient id="vc" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#4F7CFF" /><stop offset="1" stopColor="#2D4BF0" /></linearGradient></defs>
    <rect width="32" height="32" rx="9" fill="url(#vc)" />
    <path d="M18.5 6 10 18h5.5L13.5 26 22 14h-5.5z" fill="#fff" />
  </svg>
);

export const PLATFORM_ICONS = { instagram: Instagram, youtube: YouTube, x: XLogo, linkedin: LinkedIn, facebook: Facebook };
