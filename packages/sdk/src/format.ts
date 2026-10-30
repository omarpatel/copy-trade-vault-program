import type { PublicKey } from "@solana/web3.js";

const LAMPORTS = 1_000_000_000;

type Amount = bigint | number | string;

/** Lamports (bigint, number or decimal string) → SOL as a float. */
export function lamportsToSol(lamports: Amount): number {
  return Number(BigInt(typeof lamports === "number" ? Math.trunc(lamports) : lamports)) / LAMPORTS;
}

/** A SOL amount ("1.5", 1.5) → lamports, exact for decimal strings (9 decimals max). */
export function solToLamports(sol: number | string): bigint {
  const s = typeof sol === "number" ? sol.toFixed(9) : sol.trim();
  const m = /^(-)?(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[2] === "" && (m[3] ?? "") === "")) throw new Error(`invalid SOL amount: ${sol}`);
  const [, neg, whole = "", frac = ""] = m;
  const v = BigInt(whole || "0") * 1_000_000_000n + BigInt((frac + "000000000").slice(0, 9));
  return neg ? -v : v;
}

/** Compact number: 1234 → "1.23K", 1234567 → "1.23M", 0.5 → "0.50", 0.0123 → "0.012". */
export function fmtCompact(n: number | bigint, digits = 2): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  const units: [number, string][] = [
    [1e12, "T"],
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [size, suffix] of units) {
    if (abs >= size) return `${(v / size).toFixed(digits)}${suffix}`;
  }
  if (abs >= 100) return v.toFixed(0);
  if (abs >= 1 || abs === 0) return v.toFixed(digits);
  return v.toPrecision(Math.max(1, digits));
}

/**
 * Lamports as a SOL string: "1.234", "0.000512", "12.3K" for ≥ 1000 SOL. `digits` = decimals for
 * amounts ≥ 1 SOL; smaller amounts keep 3 significant digits.
 */
export function fmtSol(lamports: Amount, digits = 3): string {
  const sol = lamportsToSol(lamports);
  if (sol === 0) return "0";
  const abs = Math.abs(sol);
  if (abs >= 1_000) return fmtCompact(sol, 2);
  if (abs >= 1) return sol.toFixed(digits);
  // Sub-SOL: 3 significant digits (0.0005123 → "0.000512").
  return sol.toFixed(Math.min(9, Math.max(digits, 2 - Math.floor(Math.log10(abs)))));
}

/**
 * A ratio as a percentage: `fmtPct(0.1234)` → "12.34%". `fromBps` reads the input as basis points
 * (`fmtPct(2500, { fromBps: true })` → "25%"); `sign` prefixes "+" on positives.
 */
export function fmtPct(value: number, opts: { digits?: number; sign?: boolean; fromBps?: boolean } = {}): string {
  const pct = opts.fromBps ? value / 100 : value * 100;
  if (!Number.isFinite(pct)) return "—";
  const digits = opts.digits ?? (Number.isInteger(pct) ? 0 : Math.abs(pct) >= 100 ? 0 : Math.abs(pct) >= 10 ? 1 : 2);
  const s = pct.toFixed(digits);
  return `${opts.sign && pct > 0 ? "+" : ""}${s}%`;
}

/** "AbCd…WxYz". */
export function shortAddr(address: string | PublicKey, n = 4): string {
  const a = typeof address === "string" ? address : address.toBase58();
  return a.length <= n * 2 + 1 ? a : `${a.slice(0, n)}…${a.slice(-n)}`;
}

/** Raw token units (6 decimals) → whole tokens as a float. */
export function tokensToUi(raw: Amount, decimals = 6): number {
  return Number(BigInt(typeof raw === "number" ? Math.trunc(raw) : raw)) / 10 ** decimals;
}
