/**
 * Copier program constants with no runtime web3 dependency (safe for light browser bundles);
 * copiers programs/copy-vault/src/constants.rs.
 */

export const SEEDS = {
  config: "config",
  copier: "copier",
  vault: "vault",
  position: "position",
  burnPool: "platform-burn",
  pending: "pending",
} as const;

/** Lower bound of the target's creator-fee cut (bps of creator fees). */
export const TRADER_MIN_BPS = 100;
/** Upper bound of the target's creator-fee cut (bps of creator fees). */
export const TRADER_MAX_BPS = 2_500;
/** Share of realized profit above the HWM that buys back & burns the platform token. */
export const PROFIT_PLATFORM_BPS = 2_500;
/** Share of realized profit above the HWM that buys back & burns the copier's own coin. */
export const PROFIT_BUYBACK_BPS = 7_500;
/** Index copiers copy at most this many target wallets. */
export const MAX_INDEX_TARGETS = 16;
/** `Config.descriptors` capacity. */
export const MAX_DESCRIPTORS = 32;
/** Minimum seconds between two `buyback_burn` calls of one copier, and between two `burn_platform` calls. */
export const BUYBACK_MIN_INTERVAL_SECS = 60;
/** Rent the program accepts pump charging the vault on a buy (UVA / ATA), booked as cost. */
export const TRADE_RENT_ALLOWANCE_LAMPORTS = 10_000_000n;

export const BPS = 10_000n;
export const LAMPORTS_PER_SOL_BIG = 1_000_000_000n;
/** create_v2 coins: 6 decimals, 1B supply. */
export const TOKEN_DECIMALS = 6;
export const TOKEN_UNIT = 1_000_000n;
export const PUMP_TOKEN_TOTAL_SUPPLY = 1_000_000_000n * TOKEN_UNIT;

/** Default `Config.params` seeded by `initialize_config` (programs/copy-vault constants.rs `DEFAULT_*`). */
export const DEFAULT_PARAMS = {
  maxTradeBps: 1_000,
  maxPositionBps: 2_000,
  maxOpenPositions: 12,
  minTradeLamports: 10_000_000n,
  minSignalLamports: 50_000_000n,
  signalMultipleBps: 10_000,
  maxImpactBps: 300,
  slippageBps: 500,
  vaultFloorLamports: 20_000_000n,
  maxHoldSecs: 604_800n,
  keeperGraceSecs: 3_600n,
  spendWindowSecs: 3_600n,
  maxWindowSpendBps: 3_000,
} as const;

/**
 * Inclusive ranges every param must stay inside (`Params::validate`, constants.rs `RANGE_*`);
 * `propose_params` and `execute_pending` reject anything outside with `ParamOutOfRange`.
 */
export const PARAM_RANGES = {
  maxTradeBps: { min: 1, max: 2_500 },
  maxPositionBps: { min: 1, max: 3_500 },
  maxOpenPositions: { min: 1, max: 24 },
  minTradeLamports: { min: 1_000_000n, max: 1_000_000_000n },
  minSignalLamports: { min: 1_000_000n, max: 10_000_000_000n },
  signalMultipleBps: { min: 1, max: 10_000 },
  maxImpactBps: { min: 50, max: 1_000 },
  slippageBps: { min: 300, max: 1_500 },
  vaultFloorLamports: { min: 5_000_000n, max: 1_000_000_000n },
  maxHoldSecs: { min: 86_400n, max: 2_592_000n },
  keeperGraceSecs: { min: 600n, max: 604_800n },
  spendWindowSecs: { min: 600n, max: 86_400n },
  maxWindowSpendBps: { min: 500, max: 5_000 },
} as const;

/** Admin timelock bounds (`initialize_config(keeper, timelock_secs)`). */
export const MIN_TIMELOCK_SECS = 60;
export const MAX_TIMELOCK_SECS = 604_800;
/** A queued change may execute for this long after its eta (`PendingChange.expires_at = eta + this`). */
export const EXECUTE_WINDOW_SECS = 604_800;
/** `Config.latest_change_ids` entry meaning "no live change of this kind" (u64::MAX). */
export const NO_CHANGE_ID = 2n ** 64n - 1n;
/** Upper bound of a descriptor's `min_accounts`. */
export const MAX_DESCRIPTOR_ACCOUNTS = 40;
