/**
 * Read-only health check of a deployed copy-vault (any cluster), for daily ops and incident triage.
 * Exits 1 when something needs action:
 *
 *  - timelock queue: every pending admin change (keeper / params / descriptors / index targets) and a pending admin,
 *    with its ETA. The timelock exists so a change can be seen and stopped before it applies, so each one is an
 *    alert until it is listed as expected in EXPECTED_PENDING (comma-separated ids, `admin` for a pending admin);
 *  - keeper: paused (no keeper), wallet below KEEPER_MIN_SOL, heartbeat older than `keeper_grace_secs` (exits of
 *    positions whose target is flat are then open to anyone);
 *  - per copier: fee routing intact, i.e. the sharing config is still active + admin-revoked with exactly the
 *    shareholders the copier registered (target X / vault 10000 − X, or vault 100% for an index) and the bonding
 *    curve's (or graduated pool's) creator is still the sharing config. A pump.fun `admin_cto` / sharing-config
 *    reset shows up here as ✗;
 *  - burns draining: the platform token burn pool and each copier's buyback pool must not sit above STUCK_POOL_SOL with no
 *    burn for STUCK_POOL_MINS (a crank failing in simulation is otherwise invisible: the keeper backs off quietly).
 *
 *   CLUSTER=mainnet-beta RPC_URL=… pnpm ops:check     (KEEPER_MIN_SOL default 0.5, EXPECTED_PENDING e.g. "3,admin",
 *                                                     STUCK_POOL_SOL default 0.25, STUCK_POOL_MINS default 30)
 */
import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import {
  bondingCurvePda,
  burnPoolPda,
  canonicalPoolPda,
  decodeBondingCurve,
  decodePool,
  decodeSharingConfig,
  fetchAllCopiers,
  fetchConfig,
  fetchPendingChanges,
  pendingChangeStatus,
  copierShareholders,
  sharingConfigPda,
  vaultPda,
  type CopierAccount,
} from "@copy-trade-vault/sdk";
import { CLUSTER, RPC_URL, main, sol } from "./common";

const KEEPER_MIN_SOL = Number(process.env.KEEPER_MIN_SOL ?? 0.5);
const EXPECTED_PENDING = new Set((process.env.EXPECTED_PENDING ?? "").split(",").map((s) => s.trim()).filter(Boolean));
const STUCK_POOL_SOL = Number(process.env.STUCK_POOL_SOL ?? 0.25);
const STUCK_POOL_MINS = Number(process.env.STUCK_POOL_MINS ?? 30);

/** "in 23h 59m" / "ready since 5m" for an ETA. */
function eta(unix: bigint, now: bigint): string {
  const d = Number(unix - now);
  const span = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m` : `${s}s`);
  return `${d > 0 ? `executable in ${span(d)}` : `executable since ${span(-d)}`} (${new Date(Number(unix) * 1000).toISOString()})`;
}

/** Problems with a copier's fee routing (empty = intact). */
async function feeRoutingProblems(connection: Connection, m: CopierAccount): Promise<string[]> {
  const sharing = sharingConfigPda(m.mint);
  const [scInfo, curveInfo, poolInfo] = await connection.getMultipleAccountsInfo([sharing, bondingCurvePda(m.mint), canonicalPoolPda(m.mint)]);
  if (!scInfo) return ["sharing config missing"];
  const sc = decodeSharingConfig(scInfo.data);
  const problems: string[] = [];
  if (sc.status !== "active") problems.push(`sharing config ${sc.status}`);
  if (!sc.adminRevoked) problems.push(`sharing config admin ${sc.admin.toBase58()} not revoked`);
  const vault = vaultPda(m.mint);
  const expected = copierShareholders(m).map((address) => ({ address, shareBps: address.equals(vault) ? 10_000 - m.traderBps : m.traderBps }));
  const same =
    sc.shareholders.length === expected.length &&
    expected.every((e) => sc.shareholders.some((s) => s.address.equals(e.address) && s.shareBps === e.shareBps));
  if (!same) problems.push(`shareholders changed: ${sc.shareholders.map((s) => `${s.address.toBase58()} ${s.shareBps / 100}%`).join(", ")}`);
  if (curveInfo) {
    const curve = decodeBondingCurve(curveInfo.data);
    if (!curve.creator.equals(sharing)) problems.push(`bonding curve creator is ${curve.creator.toBase58()}, not the sharing config (CTO?)`);
  }
  if (poolInfo) {
    const pool = decodePool(poolInfo.data);
    if (!pool.coinCreator.equals(sharing)) problems.push(`pool coin_creator is ${pool.coinCreator.toBase58()}, not the sharing config (CTO?)`);
  }
  return problems;
}

main(async () => {
  const connection = new Connection(RPC_URL, "confirmed");
  const config = await fetchConfig(connection);
  if (!config) throw new Error(`copier config not initialized on ${CLUSTER} (${RPC_URL})`);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const paused = config.keeper.equals(PublicKey.default);
  const [keeperBalance, burnPool, pending] = await Promise.all([
    paused ? Promise.resolve(0) : connection.getBalance(config.keeper),
    connection.getBalance(burnPoolPda()),
    fetchPendingChanges(connection),
  ]);
  let alerts = 0;
  const flag = (ok: boolean) => {
    if (!ok) alerts++;
    return ok ? "✓" : "✗";
  };
  const heartbeatAge = now - config.keeperHeartbeatTs;
  const grace = config.params.keeperGraceSecs;

  console.log(`copy-vault on ${CLUSTER} (${RPC_URL})`);
  console.log(`  admin          ${config.admin.toBase58()}   timelock ${config.timelockSecs}s`);
  if (!config.pendingAdmin.equals(PublicKey.default)) {
    console.log(`  ${flag(EXPECTED_PENDING.has("admin"))} pending admin  ${config.pendingAdmin.toBase58()}  accept ${eta(config.pendingAdminEta, now)}`);
  }
  if (paused) {
    console.log(`  ${flag(false)} keeper       PAUSED (no keeper: copies, buybacks and burns stop)`);
  } else {
    console.log(`  ${flag(keeperBalance >= KEEPER_MIN_SOL * LAMPORTS_PER_SOL)} keeper       ${config.keeper.toBase58()}  ${sol(keeperBalance)} SOL (min ${KEEPER_MIN_SOL})`);
  }
  console.log(
    `  ${flag(heartbeatAge <= grace)} heartbeat    ${heartbeatAge}s ago (grace ${grace}s${heartbeatAge > grace ? ": exits of flat-target positions are now permissionless" : ""})`,
  );
  console.log(`  the platform token        ${config.platformMint.equals(PublicKey.default) ? "not set" : config.platformMint.toBase58()}`);
  const stuckSecs = BigInt(STUCK_POOL_MINS * 60);
  const stuckLamports = STUCK_POOL_SOL * LAMPORTS_PER_SOL;
  const burnPoolStuck =
    !config.platformMint.equals(PublicKey.default) && burnPool > stuckLamports && now - config.lastPlatformBurnTs > stuckSecs;
  console.log(
    `  ${flag(!burnPoolStuck)} burn pool    ${burnPoolPda().toBase58()}  ${sol(burnPool)} SOL` +
      (burnPoolStuck ? `: not draining (no burn_platform for ${STUCK_POOL_MINS}+ min; check the keeper's burn_platform cranks)` : ""),
  );
  console.log(`  params         max hold ${config.params.maxHoldSecs}s, spend window ${config.params.maxWindowSpendBps / 100}%/${config.params.spendWindowSecs}s, ${config.descriptors.length} descriptors`);

  const live = pending.filter(({ account: c }) => {
    const status = pendingChangeStatus(c, config, now);
    return status === "queued" || status === "executable";
  });
  console.log(`\n${live.length} live pending change(s)${live.length ? " (each is an alert unless listed in EXPECTED_PENDING)" : ""}:`);
  for (const { address, account: c } of pending) {
    const status = pendingChangeStatus(c, config, now);
    const what =
      c.kind === "keeper"
        ? `keeper → ${c.keeper.toBase58()}`
        : c.kind === "indexTargets"
          ? `index targets of ${c.copier.toBase58()} → ${c.targets.length} wallets`
          : c.kind === "descriptors"
            ? `descriptors → ${c.descriptors.length}`
            : "params";
    if (status === "superseded" || status === "expired") {
      // Dead: can never execute. Only rent is parked there; anyone may close it.
      console.log(`  · #${c.id} ${what}: ${status}, closable with \`pnpm admin discard ${c.id} --yes\``);
      continue;
    }
    const timing = status === "queued" ? eta(c.eta, now) : `EXECUTABLE now, until ${new Date(Number(c.expiresAt) * 1000).toISOString()}`;
    console.log(`  ${flag(EXPECTED_PENDING.has(String(c.id)))} #${c.id} ${what}, proposed by ${c.proposer.toBase58()}, ${timing}  ${address.toBase58()}`);
  }

  const copiers = await fetchAllCopiers(connection);
  console.log(`\n${copiers.length} copiers:`);
  for (const { account: m } of copiers.sort((a, b) => Number(b.account.capitalIn + b.account.feesIn - a.account.capitalIn - a.account.feesIn))) {
    const problems = await feeRoutingProblems(connection, m);
    const vault = await connection.getBalance(vaultPda(m.mint));
    const isToken = m.mint.equals(config.platformMint);
    const buybackStuck = m.buybackPool > BigInt(stuckLamports) && now - m.lastBuybackTs > stuckSecs;
    if (buybackStuck) problems.push(`buyback pool ${sol(m.buybackPool)} SOL not draining (no buyback_burn for ${STUCK_POOL_MINS}+ min)`);
    console.log(
      `  ${flag(problems.length === 0)} ${m.mint.toBase58()}${isToken ? " (the platform token)" : ""}  ${m.kind} ${m.targets.length} target(s), cut ${m.traderBps / 100}%` +
        `  vault ${sol(vault)} SOL, capital ${sol(m.capitalIn)}, fees ${sol(m.feesIn)}, pnl ${sol(m.realizedPnl)}, buyback pool ${sol(m.buybackPool)}, open ${m.openPositions}`,
    );
    for (const p of problems) console.log(`      ✗ ${p}`);
  }
  if (alerts) throw new Error(`${alerts} check(s) need attention`);
  console.log("\nall checks passed");
});
