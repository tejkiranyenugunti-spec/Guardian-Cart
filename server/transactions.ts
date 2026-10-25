// Card transaction providers. The application only depends on VisaTransactionProvider.
// Today GuardianCart runs on SimulatedTransactionProvider. If Visa grants sandbox access
// (Visa Transaction Controls / Visa Intelligent Commerce), RealVisaTransactionProvider is
// the only thing to implement: the pipeline, policy engine and apps stay unchanged.
import { randomUUID } from "node:crypto";
import { MCC } from "../shared/data";
import type { Channel, TransactionEvent, TransactionType } from "../shared/types";

export type EventHandler = (event: TransactionEvent) => Promise<AuthorizationResponse>;

/** What we answer to the card network: approve or decline (decline-and-hold for check-ins). */
export interface AuthorizationResponse {
  transaction_id: string;
  decision: "approve" | "decline";
  status: "approved" | "paused" | "blocked" | "released" | "duplicate";
  reason: string;
  household?: string;
}

export interface VisaTransactionProvider {
  readonly name: string;
  readonly kind: "simulated" | "visa";
  /** Whether this provider can run with the current configuration. */
  isConfigured(): boolean;
  /** Start receiving events. The handler returns the authorization decision for each one. */
  start(handler: EventHandler): Promise<void>;
  stop(): Promise<void>;
}

export class ProviderNotConfigured extends Error {}
export class InvalidTransactionEvent extends Error {}

const TYPES: TransactionType[] = ["purchase", "funds_transfer", "quasi_cash", "cash_withdrawal"];
const CHANNELS: Channel[] = ["in_store", "online"];

/** Validate and normalize a raw event (webhook body, CLI args, stage scenario). Throws InvalidTransactionEvent. */
export function normalizeEvent(raw: unknown, defaults: { card_id: string; source: "simulated" | "visa" }): TransactionEvent {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const merchant = typeof o.merchant === "string" ? o.merchant.trim().replace(/\s+/g, " ") : "";
  if (!merchant || merchant.length > 80) throw new InvalidTransactionEvent("merchant is required (max 80 characters)");
  const mcc = String(o.merchant_category ?? o.mcc ?? "").trim();
  if (!/^\d{4}$/.test(mcc)) throw new InvalidTransactionEvent("merchant_category must be a 4-digit MCC, e.g. 5912");
  const amount = typeof o.amount === "string" ? Number(o.amount) : (o.amount as number);
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0 || amount > 100_000) {
    throw new InvalidTransactionEvent("amount must be a number between 0 and 100000");
  }
  const type = (o.transaction_type ?? "purchase") as TransactionType;
  if (!TYPES.includes(type)) throw new InvalidTransactionEvent(`transaction_type must be one of ${TYPES.join(", ")}`);
  const channelRaw = String(o.channel ?? o.in_store_or_online ?? "in_store").replace("-", "_");
  const channel = (channelRaw === "instore" ? "in_store" : channelRaw) as Channel;
  if (!CHANNELS.includes(channel)) throw new InvalidTransactionEvent("channel must be in_store or online");
  const ts = o.timestamp ? new Date(String(o.timestamp)) : new Date();
  if (Number.isNaN(ts.getTime())) throw new InvalidTransactionEvent("timestamp must be ISO 8601");
  const id = typeof o.transaction_id === "string" && o.transaction_id.trim() ? o.transaction_id.trim().slice(0, 64) : `sim_${randomUUID().slice(0, 12)}`;
  const card = typeof o.card_id === "string" && o.card_id.trim() ? o.card_id.trim() : defaults.card_id;
  return {
    transaction_id: id,
    card_id: card,
    merchant,
    merchant_category: mcc,
    amount: Math.round(amount * 100) / 100,
    currency: "USD",
    timestamp: ts.toISOString(),
    transaction_type: type,
    channel,
    source: defaults.source,
  };
}

export const mccLabel = (mcc: string) => MCC[mcc] ?? `Other merchant (MCC ${mcc})`;
export const merchantKey = (merchant: string) =>
  merchant
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/\b(pharmacy|store|inc|llc|co)\b/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .replace(/^traderjoe(s)?$/, "traderjoes")
    .replace(/^peetscoffee$|^peets$/, "peets")
    .replace(/^acehardware$/, "ace") || "merchant";

/** The provider used today: events come from our own webhook, CLI, card-simulator page and stage. */
export class SimulatedTransactionProvider implements VisaTransactionProvider {
  readonly name = "Simulated card network";
  readonly kind = "simulated" as const;
  private handler?: EventHandler;

  isConfigured() {
    return true;
  }
  async start(handler: EventHandler) {
    this.handler = handler;
  }
  async stop() {
    this.handler = undefined;
  }
  /** Push one simulated authorization into the pipeline, exactly as a network webhook would. */
  async submit(raw: unknown, defaultCardId: string): Promise<AuthorizationResponse> {
    if (!this.handler) throw new Error("Simulated provider is not started");
    const event = normalizeEvent(raw, { card_id: defaultCardId, source: "simulated" });
    return this.handler(event);
  }
}

/**
 * Placeholder for a real Visa integration (VTC or VIC sandbox). Intentionally not implemented:
 * we do not claim to control a real Visa card. To implement: receive Visa's authorization /
 * control notifications (mutual-TLS webhook), map them with normalizeEvent(..., {source: "visa"}),
 * call the handler, and translate AuthorizationResponse back into Visa's decision format.
 */
export class RealVisaTransactionProvider implements VisaTransactionProvider {
  readonly name = "Visa (sandbox)";
  readonly kind = "visa" as const;
  isConfigured() {
    return Boolean(process.env.VISA_USER_ID && process.env.VISA_PASSWORD && process.env.VISA_CERT_PATH);
  }
  async start(_handler: EventHandler) {
    throw new ProviderNotConfigured(
      "RealVisaTransactionProvider is a placeholder. No Visa sandbox access yet, so GuardianCart uses SimulatedTransactionProvider.",
    );
  }
  async stop() {}
}
