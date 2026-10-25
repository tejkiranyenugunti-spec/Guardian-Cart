import { normalizeEvent } from "../server/transactions";
import type { Guardian } from "../server/guardian";
import type { ScenarioId } from "../shared/data";

/** Push a scenario through the same event normalization + pipeline entry the server uses. */
export async function simulate(g: Guardian, scenario: ScenarioId) {
  const ev = normalizeEvent(g.scenarioEvent(scenario), { card_id: "card-test", source: "simulated" });
  const res = await g.ingest(ev);
  await g.idle();
  return g.state.transactions.find((t) => t.id === res.transaction_id)!;
}
