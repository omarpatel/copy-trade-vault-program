/** The platform token index basket (scripts/copier-basket.json), validated against the verified KOL directory. */
import { PublicKey } from "@solana/web3.js";
import { MAX_INDEX_TARGETS } from "@copy-trade-vault/sdk";
import path from "node:path";
import { ROOT, readJson, rel } from "./common";

export const BASKET_FILE = path.resolve(ROOT, process.env.BASKET_FILE ?? "scripts/copier-basket.json");
const KOLS_FILE = path.join(ROOT, "apps/indexer/src/kols.json");

export interface BasketEntry {
  name: string;
  handle: string;
  address: string;
  source: string;
}

interface KolEntry {
  address: string;
  name: string;
  tags?: string[];
}

/**
 * The basket's wallets in file order: 1–16 distinct addresses, each in apps/indexer/src/kols.json (curated
 * directory) and not tagged `hft`.
 */
export function loadBasket(): { entries: BasketEntry[]; targets: PublicKey[] } {
  const basket = readJson<{ targets: BasketEntry[] }>(BASKET_FILE);
  if (!basket?.targets?.length) throw new Error(`${rel(BASKET_FILE)} has no targets`);
  if (basket.targets.length > MAX_INDEX_TARGETS) throw new Error(`${rel(BASKET_FILE)}: ${basket.targets.length} targets, at most ${MAX_INDEX_TARGETS}`);
  const kols = new Map((readJson<KolEntry[]>(KOLS_FILE) ?? []).map((k) => [k.address, k]));
  const seen = new Set<string>();
  const targets = basket.targets.map((t) => {
    const key = new PublicKey(t.address);
    if (seen.has(t.address)) throw new Error(`${rel(BASKET_FILE)}: ${t.address} listed twice`);
    seen.add(t.address);
    const kol = kols.get(t.address);
    if (!kol) throw new Error(`${rel(BASKET_FILE)}: ${t.name} ${t.address} is not in the verified directory ${rel(KOLS_FILE)}`);
    if (kol.tags?.includes("hft")) throw new Error(`${rel(BASKET_FILE)}: ${t.name} is tagged hft (poor copy target)`);
    return key;
  });
  return { entries: basket.targets, targets };
}
