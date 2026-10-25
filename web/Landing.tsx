import { Icon } from "./ui";

export function Landing() {
  return (
    <div className="landing">
      <div className="landing-inner fade-up">
        <div className="brand">
          <span className="brand-mark">
            <Icon name="shield" size={20} stroke={2.2} />
          </span>
          <span className="brand-name">GuardianCart</span>
        </div>
        <h1 className="landing-title">A calm helper that stops scam payments, and keeps Mom in charge.</h1>
        <p className="landing-lead">
          Rosa shops the way she always has. When something unusual happens on her card, her helper pauses that one payment and asks her one question. If it's a scam, the money stays put and Priya hears about it right away.
        </p>
        <div className="landing-choices">
          <a className="choice" href="/rosa">
            <span className="choice-icon rosa">R</span>
            <span>
              <span className="choice-title">I'm Rosa</span>
              <span className="choice-sub">Open my helper (tablet)</span>
            </span>
            <span className="choice-arrow">→</span>
          </a>
          <a className="choice" href="/family">
            <span className="choice-icon priya">P</span>
            <span>
              <span className="choice-title">I'm Priya</span>
              <span className="choice-sub">Check on Mom (phone)</span>
            </span>
            <span className="choice-arrow">→</span>
          </a>
        </div>
        <div className="landing-foot">
          <span className="sim-tag">SIMULATED</span> Card payments come from a simulated card network for now (<a href="/card-simulator">card simulator</a>). ·{" "}
          <a href="/stage">Presentation mode</a>
        </div>
      </div>
    </div>
  );
}
