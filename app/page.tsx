import Features from "@/components/Features";
import { Logo } from "@/components/icons";
import Studio from "@/components/Studio";

export default function Home() {
  return (
    <>
      <header className="nav">
        <div className="wrap">
          <a className="brand" href="#top"><Logo /> ViralCut</a>
          <nav className="nav-links" aria-label="Main">
            <a href="#features">Features</a>
            <a href="#how">How it works</a>
            <a href="#faq">FAQ</a>
          </nav>
        </div>
      </header>
      <main>
        <Studio />
        <Features />
      </main>
      <footer>
        <div className="wrap">
          <span>© ViralCut</span>
          <span>Only clip videos you own or have permission to repurpose.</span>
        </div>
      </footer>
    </>
  );
}
