import type { DirectorySource, TraderStats } from "@copy-trade-vault/sdk/api";

/** Sources fetched from the network (the rest — `curated`, `localnet` — are local files). */
export type RemoteSource = Exclude<DirectorySource, "curated" | "localnet">;

/** One wallet as one source describes it, normalized. Unknown values are null, never guessed. */
export interface SourceWallet {
  source: DirectorySource;
  /** Canonical base58 pubkey. */
  address: string;
  name: string | null;
  /** X handle without `@`. */
  handle: string | null;
  /** Display name on X / the source's profile, when it differs from `name`. */
  displayName: string | null;
  /** Upstream image URL (fetched + cached by the indexer, never hotlinked). */
  avatarUrl: string | null;
  /** Follower count the source reports (its own platform's, or X's for X-backed sources). */
  followers: number | null;
  /** The wallet's page on the source. */
  url: string | null;
  /** 1-based rank on the source's main leaderboard (best window), null when unranked. */
  rank: number | null;
  stats: TraderStats;
  tags: string[];
  notes: string | null;
  /**
   * Profile enrichment only (e.g. pump.fun's profile of a kolscan wallet): contributes avatar/followers/handle when
   * the wallet is listed elsewhere, but doesn't list it or count as a source.
   */
  profileOnly?: boolean;
}

/** A source's result: wallets plus when they were fetched. */
export interface SourceResult {
  source: RemoteSource;
  fetchedAt: number;
  wallets: SourceWallet[];
}

export interface FetchLog {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface FetchContext {
  /** Every wallet the other sources currently list, with its merged X handle (for profile enrichment). */
  known: { address: string; handle: string | null }[];
  /** This source's rows from its last successful run (carry forward slow-to-refresh enrichment). */
  previous: SourceWallet[];
}

export interface DirectorySourceModule {
  id: RemoteSource;
  /** Refresh period. */
  intervalMs: number;
  /** Disabled sources (missing API key) are skipped by the scheduler and the refresh script. */
  enabled(): boolean;
  fetch(log: FetchLog, ctx: FetchContext): Promise<SourceResult>;
}

export const EMPTY_STATS: TraderStats = {
  pnl1dUsd: null,
  pnl7dUsd: null,
  pnl30dUsd: null,
  winRate7d: null,
  winRate30d: null,
  trades7d: null,
  trades30d: null,
  avgHoldSecs: null,
  lastActiveTs: null,
};

export function emptyWallet(source: DirectorySource, address: string): SourceWallet {
  return {
    source,
    address,
    name: null,
    handle: null,
    displayName: null,
    avatarUrl: null,
    followers: null,
    url: null,
    rank: null,
    stats: { ...EMPTY_STATS },
    tags: [],
    notes: null,
  };
}
