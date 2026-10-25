import { Facebook, Instagram, Logo, Sparkle, XLogo, YouTube } from "./icons";

export default function Features() {
  return (
    <>
      <section className="section" id="features">
        <div className="wrap">
          <div className="section-head">
            <span className="eyebrow">Everything a clipping team does</span>
            <h2>From one long video to a week of viral posts</h2>
            <p className="muted">Podcasts, streams, interviews, talks, webinars. ViralCut watches the whole thing so you don&apos;t have to.</p>
          </div>
          <div className="features">
            <article className="feature">
              <div className="visual">
                <div className="ai-card">
                  <div className="detect-head"><Sparkle /> AI Detection</div>
                  <div className="detect-head" style={{ fontWeight: 600 }}><span className="dot" /> Analyzing video content…</div>
                  <div className="found"><span>Found 12 potential clips</span><span className="mono">87%</span></div>
                  <div className="bar"><i style={{ width: "87%" }} /></div>
                </div>
              </div>
              <h3>AI-powered clip detection</h3>
              <p>AI (Gemini, Groq or Claude) reads the full transcript and scores every moment for hooks, stories, emotion, numbers and payoff, then picks the clips most likely to go viral.</p>
            </article>

            <article className="feature">
              <div className="visual">
                <div className="face" aria-hidden="true">
                  <svg viewBox="0 0 150 150" width="150" height="150">
                    <defs><radialGradient id="stone" cx=".45" cy=".35"><stop offset="0" stopColor="#d9d6cf" /><stop offset="1" stopColor="#6d6a66" /></radialGradient></defs>
                    <ellipse cx="75" cy="70" rx="42" ry="52" fill="url(#stone)" />
                    <path d="M33 58c4-30 22-42 42-42s40 12 42 42c-8-12-20-20-42-20s-34 8-42 20z" fill="#9b978f" />
                    <rect x="55" y="118" width="40" height="32" fill="#7d7a75" />
                    <ellipse cx="60" cy="72" rx="6" ry="3" fill="#4b4844" /><ellipse cx="90" cy="72" rx="6" ry="3" fill="#4b4844" />
                    <path d="M75 76v16M66 100c6 4 12 4 18 0" stroke="#55524d" strokeWidth="3" fill="none" strokeLinecap="round" />
                  </svg>
                  <span className="frame" /><span className="cross-h" /><span className="cross-v" />
                </div>
              </div>
              <h3>Face tracking reframe</h3>
              <p>Wide videos are reframed to 9:16 around the speaker&apos;s face, with smooth camera moves and clean cuts when the speaker changes.</p>
            </article>

            <article className="feature">
              <div className="visual">
                <div className="flow">
                  <span className="src"><Logo size={26} /></span>
                  <svg className="lines" viewBox="0 0 100 170" preserveAspectRatio="none" aria-hidden="true">
                    <path d="M0 85 C 50 85, 50 20, 100 20" stroke="#3e6bff" strokeWidth="1.5" fill="none" />
                    <path d="M0 85 L 100 85" stroke="#3e6bff" strokeWidth="1.5" fill="none" />
                    <path d="M0 85 C 50 85, 50 150, 100 150" stroke="#3e6bff" strokeWidth="1.5" fill="none" />
                  </svg>
                  <div className="outs">
                    <span className="mini-short"><i /> <Facebook size={14} /> FB Reels</span>
                    <span className="mini-short"><i /> <YouTube size={14} /> YT Short</span>
                    <span className="mini-short"><i /> <Instagram size={14} /> Reels</span>
                  </div>
                </div>
              </div>
              <h3>Multiple viral shorts</h3>
              <p>Get 3 to 10 ready-to-post 9:16 clips from one video, ranked by virality score, each with its own title and on-screen hook.</p>
            </article>

            <article className="feature">
              <div className="visual"><div className="cap-demo">THE <b>SECRET</b> IS</div></div>
              <h3>Captions added automatically</h3>
              <p>Word-by-word animated captions in bold pop, karaoke, neon or minimal style, plus a hook title for the first 3 seconds.</p>
            </article>

            <article className="feature">
              <div className="visual">
                <div className="posts-demo">
                  <div><YouTube size={18} /> <span>I lost customers by being TOO cheap 😳 <span style={{ color: "#a9c2ff" }}>#sidehustle #pricing</span></span></div>
                  <div><XLogo size={18} /> <span>Underpricing isn&apos;t humble. It&apos;s a trust problem.</span></div>
                  <div><Instagram size={18} /> <span>Save this before you price your first offer 🔁</span></div>
                </div>
              </div>
              <h3>Viral posts & hashtags</h3>
              <p>Platform-native captions for YouTube Shorts, Instagram Reels, Facebook, X and LinkedIn, an X thread for the full video, and a hashtag bank.</p>
            </article>

            <article className="feature">
              <div className="visual">
                <div className="social-row">
                  <span><YouTube size={30} /></span><span><Instagram size={30} /></span><span><Facebook size={30} /></span><span><XLogo size={30} /></span>
                </div>
              </div>
              <h3>Social media scheduling</h3>
              <p>Plan every short at each platform&apos;s peak time and add the whole schedule to Google, Apple or Outlook calendar in one click.</p>
            </article>
          </div>
        </div>
      </section>

      <section className="section" id="how">
        <div className="wrap">
          <div className="section-head">
            <span className="eyebrow">How it works</span>
            <h2>Three steps, a few minutes</h2>
          </div>
          <ol className="how">
            <li><h3>Paste a link or upload</h3><p>YouTube links are read from their captions. Uploaded videos are transcribed by Whisper right in your browser.</p></li>
            <li><h3>AI finds the viral moments</h3><p>Every moment is scored for its hook, energy, emotion and payoff. You get the best clips with timestamps and the reason each will perform.</p></li>
            <li><h3>Download, post, schedule</h3><p>Export captioned 9:16 MP4s, copy the posts and hashtags, and drop the schedule into your calendar.</p></li>
          </ol>
        </div>
      </section>

      <section className="section" id="faq">
        <div className="wrap">
          <div className="section-head"><span className="eyebrow">FAQ</span><h2>Good to know</h2></div>
          <div className="faq">
            <details><summary>Does my video get uploaded anywhere?</summary><p>No. Uploaded videos are transcribed and rendered inside your browser. Only the transcript text is sent to the AI service (Gemini, Groq or Claude) to pick clips and write posts.</p></details>
            <details><summary>Why do YouTube links show previews instead of MP4 files?</summary><p>Websites can&apos;t download YouTube videos. ViralCut reads the captions, finds the clips and writes the posts; to export captioned MP4s, add the video file and every clip renders in your browser.</p></details>
            <details><summary>What about Twitch, Kick, Google Drive or Loom?</summary><p>Download the video from that site, then use Upload Video. Dropbox links and direct .mp4 links work as they are.</p></details>
            <details><summary>How long does rendering take?</summary><p>Clips render in real time, so a 45-second short takes about 45 seconds. Keep the tab open while it works. The first upload also downloads the speech model once (about 150 MB).</p></details>
            <details><summary>Which browser should I use?</summary><p>Chrome or Edge on a computer gives MP4 output and the fastest speech recognition. Safari works too; Firefox exports WebM.</p></details>
          </div>
        </div>
      </section>
    </>
  );
}
