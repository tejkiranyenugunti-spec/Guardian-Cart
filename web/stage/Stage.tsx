import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { SCENARIOS, SCRIPTED_GENUINE_ANSWER, SCRIPTED_SCAM_ANSWER, type ScenarioId } from "../../shared/data";
import type { IntegrationStatus } from "../../shared/types";
import { api, useAppState } from "../state";
import { RosaApp } from "../rosa/RosaApp";
import { FamilyApp } from "../family/FamilyApp";
import { Icon, Toast } from "../ui";

const TABLET = { w: 1180, h: 820 };
const PHONE = { w: 390, h: 844 };
const GAP = 56;
const BEZEL_T = 18;
const BEZEL_P = 14;

function useFit(ref: React.RefObject<HTMLDivElement | null>) {
  const [scale, setScale] = useState(0.6);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      const w = el.clientWidth - 48;
      const h = el.clientHeight - 64;
      const needW = TABLET.w + BEZEL_T * 2 + GAP + PHONE.w + BEZEL_P * 2;
      const needH = Math.max(TABLET.h + BEZEL_T * 2, PHONE.h + BEZEL_P * 2);
      setScale(Math.max(0.3, Math.min(w / needW, h / needH, 1.25)));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return scale;
}

export function Stage() {
  const { state } = useAppState();
  const ref = useRef<HTMLDivElement>(null);
  const scale = useFit(ref);
  const [toast, setToast] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [more, setMore] = useState(false);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      setToast((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };
  // Same provider + pipeline as the real app, scoped to the "stage" household.
  const fire = (s: ScenarioId) => act(s, () => api("/stage/simulate", { scenario: s }));
  const answer = (text: string) => act("answer", () => api("/stage/checkin/answer", { text, via: "typed" }, 30000));

  const agreed = Boolean(state?.agreement.rosaSignedAt && state?.agreement.priyaSignedAt);
  const ci = state?.checkIns.find((c) => c.id === state.activeCheckInId);
  const checkInOpen = ci && ci.phase !== "resolved";

  // Presenter keyboard shortcuts (ignored while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, button") || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "1") void fire("grocery");
      if (e.key === "2") void fire("cvs500");
      if (e.key === "3") void answer(SCRIPTED_SCAM_ANSWER);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const totalW = TABLET.w + BEZEL_T * 2 + GAP + PHONE.w + BEZEL_P * 2;
  const totalH = Math.max(TABLET.h + BEZEL_T * 2, PHONE.h + BEZEL_P * 2);

  return (
    <div className="stage">
      <div className="stage-top">
        <div className="brand on-dark">
          <span className="brand-mark">
            <Icon name="shield" size={18} stroke={2.2} />
          </span>
          <span className="brand-name">GuardianCart</span>
          <span className="brand-sub">Presentation mode · separate demo household</span>
        </div>
        {state && <Integrations s={state.integrations} />}
      </div>

      <div className="stage-floor" ref={ref}>
        <div className="stage-devices" style={{ width: totalW * scale, height: totalH * scale }}>
          <div className="stage-scale" style={{ transform: `scale(${scale})`, width: totalW, height: totalH }}>
            <div className="device tablet" style={{ width: TABLET.w + BEZEL_T * 2, height: TABLET.h + BEZEL_T * 2 }}>
              <div className="device-label">Rosa's tablet</div>
              <div className="device-screen" style={{ width: TABLET.w, height: TABLET.h }}>
                <RosaApp />
              </div>
            </div>
            <div className="device phone" style={{ width: PHONE.w + BEZEL_P * 2, height: PHONE.h + BEZEL_P * 2 }}>
              <div className="device-label">Priya's phone</div>
              <div className="device-screen" style={{ width: PHONE.w, height: PHONE.h }}>
                <FamilyApp />
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="operator">
        <div className="op-title">
          <span className="op-sim">SIMULATED</span> card activity
        </div>
        <div className="op-group">
          <OpBtn k="1" label={SCENARIOS.grocery.label} sub={SCENARIOS.grocery.sub} disabled={!agreed || !!checkInOpen || !!busy} onClick={() => fire("grocery")} />
          <OpBtn k="2" label={SCENARIOS.cvs500.label} sub={SCENARIOS.cvs500.sub} disabled={!agreed || !!checkInOpen || !!busy} onClick={() => fire("cvs500")} accent />
          <OpBtn
            k="3"
            label="Rosa's answer (typed)"
            sub={`“${SCRIPTED_SCAM_ANSWER}”`}
            disabled={!checkInOpen || !ci?.question || ci?.phase === "thinking" || !!busy}
            onClick={() => answer(SCRIPTED_SCAM_ANSWER)}
          />
        </div>
        <div className="op-group op-right">
          {more && (
            <>
              <OpBtn label={SCENARIOS.medical640.label} sub="P1 · “this was me” path" disabled={!agreed || !!checkInOpen || !!busy} onClick={() => fire("medical640")} />
              <OpBtn label="Genuine answer (typed)" sub="P1 · new walker" disabled={!checkInOpen || !ci?.question || !!busy} onClick={() => answer(SCRIPTED_GENUINE_ANSWER)} />
              <OpBtn label={SCENARIOS.wire900.label} sub="Hard block · funds transfer" disabled={!agreed || !!checkInOpen || !!busy} onClick={() => fire("wire900")} />
            </>
          )}
          <button className="op-link" onClick={() => setMore((m) => !m)}>
            {more ? "Fewer" : "More scenarios"}
          </button>
          <button className="op-link" disabled={!!busy} onClick={() => act("clear", () => api("/stage/reset", { keepRules: true }))} title="Clear activity, keep agreed rules">
            <Icon name="refresh" size={15} /> Clear activity
          </button>
          <button className="op-reset" disabled={!!busy} onClick={() => act("reset", () => api("/stage/reset", { keepRules: false }))}>
            <Icon name="refresh" size={15} /> Reset demo
          </button>
        </div>
      </div>
      <Toast message={toast} onClose={() => setToast(undefined)} />
    </div>
  );
}

function OpBtn({ label, sub, onClick, disabled, accent, k }: { label: string; sub: string; onClick: () => void; disabled?: boolean; accent?: boolean; k?: string }) {
  return (
    <button className={`op-btn${accent ? " accent" : ""}`} onClick={onClick} disabled={disabled}>
      {k && <kbd>{k}</kbd>}
      <span>
        <span className="op-label">{label}</span>
        <span className="op-sub">{sub}</span>
      </span>
    </button>
  );
}

function Integrations({ s }: { s: IntegrationStatus }) {
  const items: { name: string; mode: string; detail: string }[] = [
    { name: "Claude", mode: s.claude.mode, detail: s.claude.detail },
    { name: "Cartesia voice", mode: s.cartesiaTts.mode, detail: `${s.cartesiaTts.detail} / ${s.cartesiaStt.detail}` },
    { name: "Moss memory", mode: s.moss.mode, detail: `${s.moss.detail}${s.moss.lastLatencyMs != null ? ` · last recall ${s.moss.lastLatencyMs} ms` : ""}` },
    { name: "Visa card feed", mode: "simulated", detail: s.visa.detail },
  ];
  return (
    <div className="integrations">
      {items.map((i) => (
        <span key={i.name} className={`pill pill-${i.mode}`} title={i.detail}>
          <span className="pill-dot" />
          {i.name}
          <em>{i.mode === "live" ? "live" : i.mode === "simulated" ? "simulated" : "fallback"}</em>
        </span>
      ))}
    </div>
  );
}
