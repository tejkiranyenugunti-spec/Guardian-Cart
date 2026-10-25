// Wires card-network providers to households. One pipeline, used by the real app AND by /stage.
import path from "node:path";
import { Guardian } from "./guardian";
import { Memory } from "./memory";
import { CONFIG } from "./config";
import { JsonFileStore, MemoryStore } from "./store";
import {
  SimulatedTransactionProvider,
  type AuthorizationResponse,
  type VisaTransactionProvider,
} from "./transactions";
import type { TransactionEvent } from "../shared/types";

export class UnknownCard extends Error {}

export const HOUSEHOLDS = {
  home: { cardId: "card-rosa-4821", cardLabel: "Visa •••• 4821", demoMode: false },
  stage: { cardId: "card-stage-0001", cardLabel: "Visa •••• 0001 (presentation)", demoMode: true },
} as const;
export type HouseholdId = keyof typeof HOUSEHOLDS;
export const isHousehold = (h: string): h is HouseholdId => h in HOUSEHOLDS;

export class TransactionPipeline {
  private byCard = new Map<string, Guardian>();
  constructor(households: Map<string, Guardian>, cards: Record<string, string>) {
    for (const [hh, card] of Object.entries(cards)) {
      const g = households.get(hh);
      if (g) this.byCard.set(card, g);
    }
  }
  /** Route an event to the household that owns the card, then run the policy pipeline. */
  handle = async (event: TransactionEvent): Promise<AuthorizationResponse> => {
    const g = this.byCard.get(event.card_id);
    if (!g) throw new UnknownCard(`Unknown card ${event.card_id}`);
    return g.ingest(event);
  };
}

export interface AppServices {
  households: Map<HouseholdId, Guardian>;
  provider: SimulatedTransactionProvider;
  pipeline: TransactionPipeline;
  flushAll(): void;
}

/** Build both households and start the transaction provider. dataDir=null keeps everything in memory. */
export async function createServices(opts: { dataDir: string | null; provider?: VisaTransactionProvider }): Promise<AppServices> {
  const households = new Map<HouseholdId, Guardian>();
  for (const [hh, cfg] of Object.entries(HOUSEHOLDS) as [HouseholdId, (typeof HOUSEHOLDS)[HouseholdId]][]) {
    const store = opts.dataDir ? new JsonFileStore(path.join(opts.dataDir, `${hh}.json`)) : new MemoryStore();
    const g = new Guardian(new Memory(`${CONFIG.moss.index}-${hh}`), { household: hh, ...cfg, store: store as never });
    await g.init();
    households.set(hh, g);
  }
  const pipeline = new TransactionPipeline(households as Map<string, Guardian>, Object.fromEntries(Object.entries(HOUSEHOLDS).map(([k, v]) => [k, v.cardId])));
  const provider = (opts.provider as SimulatedTransactionProvider) ?? new SimulatedTransactionProvider();
  await provider.start(pipeline.handle);
  return { households, provider, pipeline, flushAll: () => households.forEach((g) => g.flush()) };
}
