import type React from "react";
import { StateProvider } from "./state";
import { RosaApp } from "./rosa/RosaApp";
import { FamilyApp } from "./family/FamilyApp";
import { Stage } from "./stage/Stage";
import { Landing } from "./Landing";
import { CardSimulator } from "./CardSimulator";

export function App() {
  const path = window.location.pathname.replace(/\/+$/, "") || "/";
  let view: React.ReactElement;
  if (path === "/rosa") view = <StateProvider household="home"><div className="device-full rosa-full"><RosaApp /></div></StateProvider>;
  else if (path === "/family") view = <StateProvider household="home"><div className="device-full family-full"><FamilyApp /></div></StateProvider>;
  else if (path === "/stage") view = <StateProvider household="stage"><Stage /></StateProvider>;
  else if (path === "/card-simulator") view = <StateProvider household="home"><CardSimulator /></StateProvider>;
  else view = <Landing />;
  return view;
}
