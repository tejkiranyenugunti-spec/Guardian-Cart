// Rosa's memory. Moss (real-time semantic search) when configured, with a local keyword
// fallback so the demo never depends on it. Both implement the same interface.
import { MossClient, type SessionIndex } from "@moss-js/moss";
import { CONFIG, hasMoss, withTimeout } from "./config";
import { PROFILE, SCAM_SCRIPTS } from "../shared/data";
import type { MemoryHit, MerchantStats, SafetyRule, Transaction } from "../shared/types";
import { roughMoney } from "../shared/policy";

export type MemoryKind = "purchase" | "store_pattern" | "preferred_stores" | "recurring_items" | "scam_script" | "incident" | "family_rules" | "preference";

export interface MemoryDoc {
  id: string;
  text: string;
  kind: MemoryKind;
  meta?: Record<string, string>;
}

export function buildSeedDocs(stats: MerchantStats[], rules: SafetyRule[], history: Transaction[] = []): MemoryDoc[] {
  const docs: MemoryDoc[] = [];
  // The labeled-synthetic year of card activity, one memory per purchase (card-side facts only).
  for (const t of history) {
    const d = new Date(t.time).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    docs.push({
      id: t.id,
      kind: "purchase",
      meta: { merchantId: t.merchantId },
      text: `Synthetic past purchase: ${t.merchant} (${t.category}), $${t.amount.toFixed(2)}, ${t.channel === "in_store" ? "in store" : "online"}, ${d}.`,
    });
  }
  for (const s of stats) {
    const store = PROFILE.preferredStores.find((p) => p.merchantId === s.merchantId);
    docs.push({
      id: `pattern-${s.merchantId}`,
      kind: "store_pattern",
      meta: { merchantId: s.merchantId },
      text: `Rosa's usual spending at ${s.merchant} (${s.category}): ${s.count} visits in the past year, usually ${roughMoney(s.typicalLow)} to ${roughMoney(s.typicalHigh)}, typical visit about ${roughMoney(s.median)}, largest ever ${roughMoney(s.max)}.${store ? ` ${store.note}.` : ""}`,
    });
  }
  docs.push({
    id: "preferred-stores",
    kind: "preferred_stores",
    text: `Rosa's preferred stores: ${PROFILE.preferredStores.map((s) => `${s.name} (${s.note})`).join("; ")}.`,
  });
  docs.push({
    id: "recurring-items",
    kind: "recurring_items",
    text: `Items Rosa buys again and again (from her own shopping list, not from the card): ${PROFILE.recurringItems.join(", ")}.`,
  });
  for (const s of SCAM_SCRIPTS) docs.push({ id: s.id, kind: "scam_script", meta: { pattern: s.pattern }, text: `Known scam script (${s.pattern.replace(/_/g, " ")}): ${s.text}` });
  docs.push({
    id: "family-rules",
    kind: "family_rules",
    text: `Rules Rosa and Priya agreed on together: ${rules.map((r) => r.title).join("; ")}. Trusted contact: ${PROFILE.trustedContact.phoneLabel}.`,
  });
  docs.push({ id: "preference-speech", kind: "preference", text: `How Rosa likes to be spoken to: ${PROFILE.speechPreference}` });
  return docs;
}

// ------------------------------------------------------------------ local fallback
const STOP = new Set("a an the to of and or in on at for is was me my i he she it that this with you your from be by as are do did".split(" "));
const tokens = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9$ ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w))
    .map((w) => w.replace(/(ing|ed|es|s)$/, ""));

class LocalMemory {
  docs = new Map<string, MemoryDoc>();
  add(docs: MemoryDoc[]) {
    for (const d of docs) this.docs.set(d.id, d);
  }
  remove(ids: string[]) {
    for (const id of ids) this.docs.delete(id);
  }
  query(q: string, kind?: MemoryKind, topK = 3, meta?: Record<string, string>): MemoryHit[] {
    const qt = new Set(tokens(q));
    const out: MemoryHit[] = [];
    for (const d of this.docs.values()) {
      if (kind && d.kind !== kind) continue;
      if (meta && Object.entries(meta).some(([k, v]) => d.meta?.[k] !== v)) continue;
      const dt = new Set(tokens(d.text));
      let hit = 0;
      for (const t of qt) if (dt.has(t)) hit++;
      const score = qt.size ? hit / Math.sqrt(qt.size * Math.max(dt.size, 1)) : 0;
      out.push({ id: d.id, kind: d.kind, text: d.text, score: Math.round(score * 1000) / 1000 });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, topK);
  }
}

// ------------------------------------------------------------------ memory service
export class Memory {
  constructor(private indexName = CONFIG.moss.index) {}
  mode: "live" | "fallback" = "fallback";
  detail = "Local memory (Moss not configured)";
  lastLatencyMs?: number;
  private local = new LocalMemory();
  private session?: SessionIndex;
  private written: MemoryDoc[] = [];

  /** Documents written during use (incidents, confirmations); persisted by the household store. */
  get writes(): MemoryDoc[] {
    return [...this.written];
  }

  async init(seed: MemoryDoc[], restored: MemoryDoc[] = []) {
    this.local = new LocalMemory();
    seed = [...seed, ...restored];
    this.local.add(seed);
    this.written = [...restored];
    if (!hasMoss()) {
      this.mode = "fallback";
      this.detail = "Local memory fallback (set MOSS_PROJECT_ID / MOSS_PROJECT_KEY for Moss)";
      return;
    }
    try {
      const t0 = Date.now();
      const client = new MossClient(CONFIG.moss.projectId, CONFIG.moss.projectKey);
      // A Moss session indexes on this machine and answers queries in-process (no network hop on the hot path).
      this.session = await withTimeout(client.session(this.indexName), 20000, "Moss session");
      await withTimeout(
        this.session.addDocs(seed.map((d) => ({ id: d.id, text: d.text, metadata: { kind: d.kind, ...(d.meta ?? {}) } })), { upsert: true }),
        30000,
        "Moss seed",
      );
      this.mode = "live";
      this.detail = `Moss session "${this.indexName}" · ${seed.length} memories · ready in ${Date.now() - t0} ms`;
    } catch (e) {
      this.session = undefined;
      this.mode = "fallback";
      this.detail = `Moss unavailable (${(e as Error).message}); using local memory`;
      console.warn("[memory]", this.detail);
    }
  }

  async recall(q: string, kind?: MemoryKind, topK = 3, meta?: Record<string, string>): Promise<MemoryHit[]> {
    if (!q.trim()) return [];
    if (this.session && this.mode === "live") {
      try {
        const t0 = performance.now();
        const conds = [
          ...(kind ? [{ field: "kind", condition: { $eq: kind } }] : []),
          ...Object.entries(meta ?? {}).map(([field, v]) => ({ field, condition: { $eq: v } })),
        ];
        const filter = conds.length === 0 ? undefined : conds.length === 1 ? conds[0] : { $and: conds };
        const res = await withTimeout(this.session.query(q, { topK, alpha: 0.6, ...(filter ? { filter } : {}) }), CONFIG.moss.timeoutMs, "Moss query");
        this.lastLatencyMs = Math.round((performance.now() - t0) * 10) / 10;
        return res.docs.map((d) => ({ id: d.id, kind: d.metadata?.kind ?? kind ?? "memory", text: d.text, score: Math.round(d.score * 1000) / 1000 }));
      } catch (e) {
        console.warn("[memory] Moss query failed, using local:", (e as Error).message);
      }
    }
    const t0 = performance.now();
    const r = this.local.query(q, kind, topK, meta);
    this.lastLatencyMs = Math.round((performance.now() - t0) * 10) / 10;
    return r;
  }

  async remember(doc: MemoryDoc) {
    this.local.add([doc]);
    this.written = [...this.written.filter((d) => d.id !== doc.id), doc];
    if (this.session && this.mode === "live") {
      try {
        await withTimeout(
          this.session.addDocs([{ id: doc.id, text: doc.text, metadata: { kind: doc.kind, ...(doc.meta ?? {}) } }], { upsert: true }),
          CONFIG.moss.timeoutMs,
          "Moss write",
        );
      } catch (e) {
        console.warn("[memory] Moss write failed (kept locally):", (e as Error).message);
      }
    }
  }

  /** Forget everything written during the demo (keeps the seeded memories). */
  async forgetDemoWrites() {
    const ids = this.written.map((d) => d.id);
    this.written = [];
    this.local.remove(ids);
    if (ids.length && this.session && this.mode === "live") {
      try {
        await withTimeout(this.session.deleteDocs(ids), CONFIG.moss.timeoutMs, "Moss delete");
      } catch (e) {
        console.warn("[memory] Moss delete failed:", (e as Error).message);
      }
    }
  }
}
