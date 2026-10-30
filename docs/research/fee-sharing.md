# copy-vault: launch flow and creator-fee routing (Pump Fees `sharing_config`)

Research date: 2026-10-04. Program IDs: Pump `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`, PumpSwap/AMM `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`, Pump Fees `pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ`.

How the claims below were checked:
- **[MAINNET-SIM]**: `simulateTransaction` against mainnet-beta with `sigVerify:false`.
- **[LOCAL-E2E]**: real signed transactions on a `solana-test-validator` (Agave 4.2.1, WSL). It ran mainnet clones of pump, pump_fees, pump_amm, mayhem and Token-2022, plus Global, FeeConfig and the fee-recipient accounts. Tested with `@pump-fun/pump-sdk@2.0.0` (npm, published 2026-09-13).
- Repro scripts are outside the repo, in `%TEMP%/pumpres/js/`: `fs-sim.mjs`, `fs-local.mjs`, `fs-feeconfig.mjs`, `fs-ammfee.mjs`.

---

## 0. TL;DR

1. **The hypothesis works. I ran it end to end.** One transaction does `create_v2(creator = launcher)` → `create_fee_sharing_config` → `update_fee_shares_v2([KOL: X bps, vault: 10000−X])`. Result:
   - `bonding_curve.creator` becomes the `sharing_config` PDA.
   - `sharing_config` ends up `version=2, status=Active, admin_revoked=true`.
   - Every later trade's creator fee is paid to the two shareholders by the permissionless `distribute_creator_fees_v2`, split exactly X / 10000−X [LOCAL-E2E].
2. **No launcher fee window if those three instructions share a transaction.** Nothing can trade before the split is final. The March 2026 "one post-launch change" rule is enforced on-chain as the single `update_fee_shares*` call (`admin_revoked`). Doing it inside the launch transaction uses up that one change, so the split is permanent. Only pump.fun's CTO admin can change it later.
3. **Size.** Create + config + update + `register_copier` fits in one transaction with a Copier platform ALT:
   - 977 B, or 1,057 B including the vault-prefund transfer.
   - About 245–275k CU.
   - Adding the **dev buy does not fit** (1,328 B > 1,232) unless you add a **per-launch ALT**: 880 B, 436k CU, verified. The other option is a **Jito bundle** [tx1 launch, tx2 dev buy].
4. **Shareholders can be anything that is not executable**: a system wallet, a zero-data system-owned PDA, or a program-owned account with data. All verified.
   - Delivery is a **System Program transfer CPI** from the pump `creator_vault` PDA, one per shareholder.
   - A shareholder with 0 lamports does not break distribution. It only raises the minimum distributable amount, and below that minimum `distribute` is a silent no-op.
5. **The Copier vault that trades must be a zero-data, system-owned PDA.** `buy_v2` debits `user` through System transfers, which I observed. Keep Copier's state in a separate PDA.
6. **Fees right now (read from on-chain FeeConfig).**
   - Bonding curve: protocol 0.95% + creator 0.30%, LP 0. That is **$3,000 creator fees per $1M volume**.
   - PumpSwap canonical pool: tiered by market cap in SOL. Creator gets 0.30% below 420 SOL, **0.95% from 420–1,470 SOL**, then steps down to 0.05% at ≥98,240 SOL.
7. **Set `mayhem=false`, `holderReward=false`, `cashback=false`, `creator_fee_bps=0`.** Holder rewards and cashback are incompatible with fee sharing (cashback can no longer be set at all). Mayhem is optional. The one interesting side effect is that mayhem coins are **immune to CTO** (error 6088), but I recommend false (§6).
8. **Main risk outside our code:** pump.fun's `admin_cto` can rewrite a fee-shared coin's `sharing_config` to a new creator at 100%. pump.fun's Terms say creator fees "may be re-routed through the CTO process" at pump.fun's sole discretion.

---

## 1. Pump Fees `SharingConfig` account and discriminators

Source: `.research/pump-public-docs/idl/pump_fees.json`. Offsets confirmed by decoding a real account [LOCAL-E2E] and a mainnet simulation [MAINNET-SIM].

PDA: `["sharing-config", mint]` under the Pump Fees program. The account is allocated at a fixed **1024 bytes** (`SharingConfig::MAX_SIZE`). Rent is **5,852,160 lamports** at current mainnet rent (5,080 lamports/byte) and the launcher pays it. There is no close instruction.

| Offset | Size | Field | Type / notes |
|---|---|---|---|
| 0 | 8 | discriminator | `[216,74,9,0,56,140,93,75]` = `d84a0900388c5d4b` |
| 8 | 1 | `bump` | u8 |
| 9 | 1 | `version` | u8. Configs from the current deployment are **2**. `update_fee_shares_v2` requires `version != 1`. The SDK's `isSharingConfigEditable` treats v1 as not editable and v2 + `admin_revoked` as not editable. A CTO reset can bump it (`ResetFeeSharingConfigEvent.new_version`). |
| 10 | 1 | `status` | `ConfigStatus` enum: `0 = Paused`, `1 = Active`. Distribution requires Active (pump error 6051). |
| 11 | 32 | `mint` | Pubkey |
| 43 | 32 | `admin` | Pubkey. Equals the creator who called `create_fee_sharing_config` (the launcher). It stays set after revocation. |
| 75 | 1 | `admin_revoked` | bool. `update_fee_shares_v2` sets it to 1. Afterwards errors are 6009 `SharingConfigAdminRevoked` / 6024 `FeeSharesAlreadyUpdated` ("Reward split can only be updated once"). |
| 76 | 4 | `shareholders.len` | u32 LE. Between 1 and 10. |
| 80 + 34·i | 32 | `shareholders[i].address` | Pubkey |
| 112 + 34·i | 2 | `shareholders[i].share_bps` | u16 LE. Each > 0, total must be 10,000, no duplicates. |

Decoded state after our launch transaction [MAINNET-SIM]:
`{"bump":255,"version":2,"status":{"active":{}},"admin":<launcher>,"adminRevoked":true,"shareholders":[[KOL,2000],[vault,8000]]}`.

Instruction discriminators (from the IDLs in `.research/pump-public-docs/idl/` and the `pump-rust-client-0.2.0` crate IDLs):

| Program | Instruction | Discriminator (bytes) | Hex |
|---|---|---|---|
| Pump Fees | `create_fee_sharing_config` | `[195,78,86,76,111,52,251,213]` | `c34e564c6f34fbd5` |
| Pump Fees | `update_fee_shares_v2` | `[111,251,49,6,78,78,106,18]` | `6ffb31064e4e6a12` |
| Pump Fees | `update_fee_shares` (v1, SOL only) | `[189,13,136,99,187,164,237,35]` | `bd0d8863bba4ed23` |
| Pump Fees | `admin_cto_sharing_config` | `[60,100,144,156,64,138,182,37]` | `3c64909c408ab625` |
| Pump | `distribute_creator_fees_v2` | `[255,203,19,79,244,68,8,159]` | `ffcb134ff444089f` |
| Pump | `distribute_creator_fees` (v1) | `[165,114,103,0,121,206,247,81]` | `a572670079cef751` |
| Pump | `get_minimum_distributable_fee` | `[117,225,127,202,134,95,68,35]` | `75e17fca865f4423` |
| Pump | `collect_creator_fee_v2` | `[207,17,138,242,4,34,19,56]` | `cf118af204221338` |
| Pump | `collect_creator_fee` (v1) | `[20,22,86,123,198,28,219,132]` | `1416567bc61cdb84` |
| Pump | `create_v2` | `[214,144,76,236,95,139,49,180]` | `d6904cec5f8b31b4` |
| Pump | `sweep_creator_fee` (new, v3 trades) | `[32,246,191,52,8,201,73,186]` | `20f6bf3408c949ba` |
| Pump | `admin_cto` | `[125,126,214,134,77,229,188,89]` | `7d7ed6864de5bc59` |
| PumpSwap | `transfer_creator_fees_to_pump_v2` | `[1,33,78,185,33,67,44,92]` | `01214eb921432c5c` |
| PumpSwap | `transfer_creator_fees_to_pump` (v1, WSOL) | `[139,52,134,85,228,229,108,241]` | `8b348655e4e56cf1` |
| PumpSwap | `collect_coin_creator_fee` | `[160,57,89,42,181,139,43,66]` | `a039592ab58b2b42` |
| PumpSwap | `sweep_creator_fee` (pool, new) | — | `20f6bf3408c949ba` (same name, so same Anchor discriminator) |

Account discriminators: `BondingCurve` `17b7f83760d8ac60`, pump `Global` `a7e8e8b1c86c727f`, `SharingConfig` `d84a0900388c5d4b`.

`BondingCurve` layout (crate IDL; mainnet curves are 151 bytes):

| Offset | Field |
|---|---|
| 8 | `virtual_token_reserves` u64 |
| 16 | `virtual_quote_reserves` u64 |
| 24 | `real_token_reserves` u64 |
| 32 | `real_quote_reserves` u64 |
| 40 | `token_total_supply` u64 |
| 48 | `complete` bool |
| 49 | `creator` Pubkey |
| 81 | `is_mayhem_mode` bool |
| 82 | `is_cashback_coin` bool |
| 83 | `quote_mint` Pubkey (default = SOL) |
| 115 | `creator_fee_bps` u64 |
| 123 | `can_edit_creator_fee` bool |
| 124 | `is_holder_reward` bool |
| 125 | `creator_fee` u64 (v3 bucket) |
| 133 | `protocol_fees` u64 (v3 bucket) |

### New in Sept 2026: v3 trades and sweep (from PumpCpiResearch plus the crate README)

`buy_v3` / `sell_v3` (bonding curve) and PumpSwap `buy_v2` / `sell_v2` no longer pay the creator fee straight into the creator vault. They accumulate it in `BondingCurve.creator_fee` or `Pool.creator_fees`.

Before the following instructions, the bucket must be emptied with the permissionless `sweep_creator_fee` in the same transaction:
- `distribute_creator_fees*`
- `update_fee_shares*`
- fee-sharing creation
- `admin_cto`

Otherwise they fail with 6095 `CreatorFeesNotSwept`. On the AMM side, `sweep_pool_creator_fee` comes before `update_fee_shares(_v2)` and `transfer_creator_fees_to_pump_v2`.

What this means for Copier:
- **The keeper's distribute crank must always prepend `sweep_creator_fee`.** It is a no-op when the bucket is empty.
- After graduation, the crank also needs the pool sweep plus `transfer_creator_fees_to_pump_v2`.
- The launch transaction is not affected, because no trade happens before `update_fee_shares_v2`.

Source: `pump-rust-client-0.2.0/README.md` lines 153–192 and `src/sdk/pump_v3.rs:335-385`.

---

## 2. What can be a shareholder, how lamports arrive, and minimums

**Delivery mechanism.** I observed this in `distribute_creator_fees_v2` logs [LOCAL-E2E]:
- The pump `creator_vault` PDA (`["creator-vault", sharing_config]` under pump) is system-owned with zero data.
- Pump pays each shareholder with an `invoke_signed` **System Program transfer**. The log shows one `Program 11111111111111111111111111111111 invoke [2]` per shareholder.
- It is not a direct lamport debit.

A System transfer puts no constraint on the destination's owner, so any writable account can be credited. The only restrictions found:
- **Executable recipient** → 6052 `UnableToDistributeCreatorFeesToExecutableRecipient`. This blocks distribution for every shareholder.
- **Uninitialized recipient** → 6070 `UnableToDistributeCreatorFeesToUninitializedAccount`. In practice pump avoids this by waiting until the uninitialized holder's share covers rent (see the minimum below).

Shareholder kinds tested. Each test was a full launch, a dev buy, a 3 SOL buy, and then distribute with a 20/80 split [LOCAL-E2E]:

| Vault kind | Result |
|---|---|
| (a) System-owned zero-data PDA of a non-existent "Copier" program id (off-curve), prefunded 890,880 lamports in the launch tx | OK. Received exactly 80%: 7,111,112 lamports vs KOL 1,777,778, ratio 4.0000. |
| (b) Program-owned account with data (200 B, owner ≠ System) | OK, identical amounts. The owning program does not run and is not consulted. |
| (c) Fresh address with 0 lamports | OK. The first payout (≥ rent) creates it as a system account. |
| KOL wallet with 0 lamports | Distribution waited. In the dev-buy transaction, `distribute` was a **no-op without error**. It paid out after the next trade raised the vault above the new minimum. |

Further evidence that program-owned PDAs are intended as shareholders: the SDK documents that `donationFeePda(mint, configId)`, a pump-fees-owned data PDA, can be "passed as a shareholder address in a subsequent `updateFeeShares` call" (`pump-sdk/src/sdk.ts:3145-3169`).

**Minimum distributable amount.** Read from `get_minimum_distributable_fee` via `OnlinePumpSdk.getMinimumDistributableFee` [LOCAL-E2E]:
- With all shareholders existing: `minimumRequired = rent_exempt_min(0)`. That is the creator vault's own rent floor, which always stays in the vault. Anything above it is distributable, even 2,963 lamports (tested).
- With an uninitialized (0-lamport) shareholder holding `s` bps: `minimumRequired = rent_min + ceil(rent_min · 10000 / s)`. Observed: 5,345,280 = 890,880 + 890,880·10000/2000 at local-validator rent. Pump guarantees each new account gets at least the rent minimum.
- `distribute` below the minimum succeeds and does nothing. Rounding dust (1 lamport) stays in the vault.

**Rent is changing.** Mainnet now returns **650,240 lamports** for a 0-byte account (5,080 lamports/byte, SIMD-0437 phase 2). `getMinimumBalanceForRentExemption(1024)` = 5,852,160. SIMD-0437 continues to 696 lamports/byte in later phases ([solana.com/upgrades/reduced-rent](https://solana.com/upgrades/reduced-rent)). Consequences:
- **Never hard-code 890,880.** The coin-fees skill's "rent exemption (890,880 lamports)" is out of date (`pump-fun-skills/coin-fees/SKILL.md:238`).
- Use `Rent::get()?.minimum_balance(0)`.

**Copier vault design implications**
- `buy_v2` moves SOL from `user` with several System transfers (bonding curve, fee recipient, creator vault, buyback) [LOCAL-E2E logs]. A System transfer `from` must be system-owned with no data. So **the account that signs as pump `user` must be a zero-data, system-owned PDA**. Our program signs for it with `invoke_signed`.
- Make that same PDA the sharing-config shareholder. Keep `CopierState` (HWM, snapshots, caps) in a separate program-owned PDA.
- Fees reach the vault without Copier code running. All accounting must be balance-delta based: `vault.lamports − rent_min − principal_tracked`.
- Prefund the vault with `rent_min(0)` at launch, either as a System transfer or inside `register_copier`. That way it exists before the first trade and never sits under the 0-lamport threshold rule.
- Do not allow an executable shareholder. `register_copier` should require the tracked wallet to be non-executable, and preferably owned by the System Program.

---

## 3. One transaction or more: measured sizes, CU, ordering, and the March 2026 rule

### Measurements

| Variant | Size | CU | Result |
|---|---|---|---|
| create_v2 + create_fee_sharing_config + update_fee_shares_v2, no ALT | 1,426 B | — | too large |
| same, with pump's public ALT `7mFD2mUtRS65XstiSAvCJuYmdesZoQwCwRJhq1p3eRMe` [MAINNET-SIM] | **1,150 B** | **275,527** (create 106,750 / cfg 76,751 / update 91,726) | **success on mainnet sim** |
| same, with a Copier **platform ALT** (22 platform-constant keys) [LOCAL-E2E] | **977 B** (1,057 B incl. vault-prefund transfer) | 243,905–266,555 | success |
| + ATA + dev `buy_v2` + `distribute`, platform ALT [LOCAL-E2E] | 1,328 B | — | too large (18 per-launch keys × 32 B) |
| + ATA + dev `buy_v2` + `distribute`, **per-launch ALT** (38 keys, all derivable from the client-generated mint) [LOCAL-E2E] | **880 B** | **435,723** | **success, fully atomic** |
| Dev buy as tx2 (ATA + buy_v2 + distribute), platform ALT | 793 B | 131–142k | success |
| Trader `buy_v2` / `distribute_creator_fees_v2` alone | 663–703 B / 457 B | ~86–114k / ~29–35k | success |

Notes:
- **Per-launch keys** are: mint, launcher, KOL, vault, bonding curve, associated bonding curve, `bonding-curve-v2`, mayhem state and token vault, `sharing_config`, `creator_vault(sc)`, its WSOL ATA, the AMM `creator_vault(sc)` authority and ATA, the launcher's ATA, and the launcher's volume accumulator.
- **A platform ALT** can hold every program-global key: Global, FeeConfig, fee recipient (pin one), buyback recipient and its ATA, event authorities, mint-authority PDA, mayhem global params and `sol_vault`, global volume accumulator, programs used as accounts, WSOL mint, and token/ATA program accounts.
- **Headroom for `register_copier`.** The 977–1,057 B launch tx leaves about 175–255 B. `register_copier` adds about 32 B (Copier program id) + 32 B (new `CopierState` PDA) + about 15 B of instruction overhead. The other accounts it reads (mint, bonding curve, sharing_config, KOL, vault, launcher, system program; Copier config via ALT) are already in the transaction. **It fits, around 1,140 B** [INFERENCE from the measured numbers].
- **Compute budget:** the pump.fun frontend uses 270k for create + 120k for a buy (`create-coin/scripts/lib/constants.mjs`). For the launch tx, request about 350k CU (≈266k measured + `register_copier`). For the atomic variant with a dev buy, request about 500k.

### Recommended ordering (safe, no launcher fee window)

- **tx1 (atomic, required):** `[ComputeBudget] → (vault prefund) → create_v2(creator=launcher) → create_fee_sharing_config → update_fee_shares_v2 → register_copier`.
  - `bonding_curve.creator` already points at the sharing config, and the split is final, before any other transaction can trade.
  - `update_fee_shares_v2`'s internal `distribute_creator_fees_v2` CPI sees an empty vault. With current shareholders `[launcher]` it pays nothing.
- **Dev buy, choose one:**
  - (i) **Jito bundle** `[tx1, tx2 = ATA + buy_v2 (+ sweep_creator_fee + distribute)]`: atomic, ordered, no snipers in between. The tip goes in the last tx.
  - (ii) **Per-launch ALT:** tx0 creates and extends the ALT with all derivable per-launch keys. After ≥1 slot of warm-up, send one atomic launch tx with the dev buy (880 B). Deactivate and close the ALT later to reclaim about 0.007 SOL; this needs a deactivation cool-down.
  - (iii) A plain follow-up tx, which can be sniped. Fees still route correctly.
- **In tx2, the buy must pass `creator_vault = creatorVaultPda(sharing_config)`, not the launcher's vault.** The SDK's `createV2AndBuyV2Instructions` assumes the launcher is the creator, so it cannot be used as-is after migration. Build `buy_v2` separately (I used `PUMP_SDK.buyV2Instruction({creator: feeSharingConfigPda(mint)})`).

### Ordering to avoid: the standard SDK create+buy, then fee sharing later

`createV2AndBuyV2Instructions` (tx1), then `create_fee_sharing_config` + `update_fee_shares_v2` (tx2):
- The dev buy's creator fee, and every trade before tx2 lands, goes to **`creator_vault(launcher)`**. That vault is keyed by wallet, not by mint, and the launcher can collect it at any time.
- If v3 trades happen in between, tx2 needs `sweep_creator_fee` first, or it fails with 6095.
- The launcher could also simply never send tx2.
- `register_copier` would have to accept the risk that the coin traded first.

### March 2026 "one post-launch change" rule

Coverage: [crypto.news, 2026-03-25](https://crypto.news/pump-fun-limits-fee-wallet-edits-as-revenue-and-volume-fall/) and [CoinMarketCap Academy](https://coinmarketcap.com/academy/article/pumpdotfun-caps-creator-fee-changes-to-one-per-token). Creators get one post-launch change to the fee-recipient settings, then the configuration is permanent.

On-chain, this is the single `update_fee_shares*` per `sharing_config`:
- It sets `admin_revoked`.
- Errors afterwards: 6009 / 6024.
- `CREATOR_FEE_SHARING.md` says it "can only be called once per `sharing_config` (the admin is revoked after)". Calling `create_fee_sharing_config` twice is a no-op.
- The legacy `transfer_fee_sharing_authority` / `revoke_fee_sharing_authority` now have empty account lists in the IDL, i.e. they are dead.

Effect on Copier: none harmful. Using the one change inside the launch tx is exactly what makes the split immutable. **`register_copier` must check `admin_revoked == 1`.**

The remaining mutability is pump.fun's **`admin_cto`**, signed by `Global.admin_set_creator_authority`, currently `UqN2p5bAzBqYdHXcgB6WLtuVrdvmy9JSAtgqZb3CMKw`:
- "new creator" path: "a fee-shared coin keeps its SharingConfig as creator and the config is rewritten to `newCreator` at 100%".
- holder-rewards path: "its SharingConfig is terminated".
- Not allowed on mayhem coins (6088).
- Source: `pump-sdk/src/sdk.ts:1819-1857`.

### Summary of the pump docs read

| Doc | What matters for Copier |
|---|---|
| `docs/FEE_PROGRAM_README.md` | Market-cap-tiered fees for bonding curves and canonical pools. Formulas `bondingCurveMarketCap = vSol·supply/vToken` and `poolMarketCap = quote·supply/base`; tier lookup `calculateFeeTier`. The tier values in its `fees.png` are from Sept 2025 and stale; read FeeConfig live (§4). |
| `docs/PUMP_CREATOR_FEE_README.md` | `creator_vault = ["creator-vault", bonding_curve.creator]`. "Be careful what `creator` pubkey you pass to `create`": it receives all creator fees until it is migrated to a sharing config. |
| `docs/PUMP_SWAP_CREATOR_FEE_README.md` | Canonical pools carry `coin_creator`. Its vault is a WSOL ATA of `["creator_vault", coin_creator]` under the AMM. After migration `coin_creator = sharing_config`, so AMM fees must be moved with `transfer_creator_fees_to_pump_v2` (it unwraps WSOL into pump's `creator_vault` lamports) and then distributed. |
| `docs/BREAKING_FEE_RECIPIENT.md` | April 28 upgrade adding 8 new protocol fee recipients as an extra **trailing account on buys and sells**: bonding-curve buy = 18 accounts, sell = 16/17; AMM buy = 26/27, sell = 24/26. This is about trade CPIs, not creator-fee recipients. Relevant to PumpCpiResearch. |
| `docs/HOLDER_REWARDS_README.md` | `create_v2` arg 8 `is_holder_reward`. With it set, the creator becomes `holderRewardsPda(mint)`, there is nothing to claim, and it is permanent. **Incompatible with Copier.** Cashback is deprecated and `create_v2` rejects `[true]`. |
| `docs/FAQ.md` | CU depends on PDA bumps and logged amounts. Use a static, generous CU limit (100k per buy or sell); there are no fee-sharing specifics. |
| `docs/instructions/CREATOR_FEE_SHARING.md` | Account tables for create, update, transfer and distribute (§7). Remaining accounts for SOL coins = shareholders in config order. Shareholder rules: max 10, no duplicates, bps > 0, sum = 10,000. |
| `docs/instructions/COIN_CREATION.md` | `create_v2` args: name ≤32, symbol ≤13, uri ≤200, `creator ≠ default`, `is_mayhem_mode`, then optional `[cashback=false]`, `[creator_fee_bps]` (ignored on SOL/USDC), `[is_holder_reward]`. 16 accounts. |

### Reusable from `pump-fun-skills`

- **`coin-fees/scripts/build-sharing-config-tx.mjs`:** shows create + update in one tx with `PUMP_SDK.createFeeSharingConfig({creator, mint, pool})` and `updateFeeShares({authority: creator, currentShareholders: [creator], newShareholders})`.
  - Use **`updateFeeSharesV2`** (quote-mint aware) as I did; it is the documented path.
  - Its decision tree (cashback → sharing config → direct creator) is useful for our indexer.
- **`coin-fees/scripts/build-distribute-fees-tx.mjs` / `fetch-distributable-info.mjs`:**
  - The keeper crank pattern for graduated coins: create the WSOL ATA if needed → `transferCreatorFeesToPump` → `distributeCreatorFees`.
  - `getMinimumDistributableFee` via simulation.
  - Add `sweep_creator_fee` / pool sweep for v3 / AMM-v2 trades.
- **`create-coin/scripts/build-create-coin-tx.mjs` + `lib/tx-build.mjs`, `lib/compute.mjs`, `lib/jito.mjs`:**
  - v0 transaction assembly with ALT and partial-signing with the mint keypair.
  - Priority-fee estimate (`getPriorityFeeEstimate`, floor 100k µlamports, cap 5M).
  - Jito tip accounts and endpoints. Single-tx send only; bundles need `/api/v1/bundles`.
  - CU constants: create 270k, buy/sell 120k, AMM 200k.
- **`create-coin/scripts/lib/coin-resolve.mjs`:** `tokenProgramIdFromMint`. Never trust `token_program` from the HTTP API.
- **Hosted alternatives** (`https://fun-block.pump.fun/agents/create-coin`, `/agents/sharing-config`, `/agents/collect-fees`): handy for prototyping. They cannot add our `register_copier` and build create and fee-sharing as separate flows, so **we should build transactions ourselves**.

---

## 4. Creator-fee schedule, read from chain on 2026-10-04 [MAINNET read via `OnlinePumpSdk.fetchFeeConfig` / `OnlinePumpAmmSdk.fetchFeeConfigAccount`]

Sources:
- Bonding-curve FeeConfig PDA `8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt` (`["fee_config", pump]` under pump_fees).
- AMM FeeConfig `5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx`.
- Confirmed live through a `buy_v2` CPI return: `get_fees_with_quote_mint` returned lp=0, protocol=95, creator=30 [LOCAL-E2E].

**Bonding curve (pre-graduation), SOL quote: a single tier for all market caps.** LP 0, **protocol 95 bps (0.95%)**, **creator 30 bps (0.30%)**, total 1.25%. `Global.buyback_basis_points = 5000`: the program sends a buyback slice to the buyback recipients. I did not pin down exactly what that slice is a share of [UNVERIFIED]; it does not affect the creator fee.

**PumpSwap canonical pool, SOL quote: tiered by `poolMarketCap` in SOL.**

| Market cap ≥ (SOL) | LP | Protocol | **Creator** | Creator $ per $1M volume |
|---|---|---|---|---|
| 0 | 2 | 93 | **30** | $3,000 |
| 420 | 20 | 5 | **95** | $9,500 |
| 1,470 | 20 | 5 | 90 | $9,000 |
| 2,460 | 20 | 5 | 85 | $8,500 |
| 3,440 | 20 | 5 | 80 | $8,000 |
| 4,420 | 20 | 5 | 75 | $7,500 |
| 9,820 | 20 | 5 | 70 | $7,000 |
| 14,740 | 20 | 5 | 65 | $6,500 |
| 19,650 | 20 | 5 | 60 | $6,000 |
| 24,560 | 20 | 5 | 55 | $5,500 |
| 29,470 | 20 | 5 | 50 | $5,000 |
| 34,380 | 20 | 5 | 45 | $4,500 |
| 39,300 | 20 | 5 | 40 | $4,000 |
| 44,210 | 20 | 5 | 35 | $3,500 |
| 49,120 | 20 | 5 | 30 | $3,000 |
| 54,030 | 20 | 5 | 28 | $2,800 |
| 58,940 | 20 | 5 | 25 | $2,500 |
| 63,860 | 20 | 5 | 23 | $2,300 |
| 68,770 | 20 | 5 | 20 | $2,000 |
| 73,681 | 20 | 5 | 18 | $1,800 |
| 78,590 | 20 | 5 | 15 | $1,500 |
| 83,500 | 20 | 5 | 13 | $1,300 |
| 88,400 | 20 | 5 | 10 | $1,000 |
| 93,330 | 20 | 5 | 8 | $800 |
| 98,240 | 20 | 5 | 5 | $500 |

Other schedules:
- Non-canonical pools (`flatFees`): lp 25 / protocol 5 / creator 0.
- Exotic quotes: 20 / 5 / 5.
- USDC-paired coins use `stableFeeTiers` with the same bps. Thresholds are in USDC base units: $59k → 95 bps … $20M → 5 bps.

**Website estimator**

```
creator_bps = curve ? 30 : tier(poolMarketCapSOL)   // read both FeeConfig accounts live; never hard-code
creator_fees_usd = volume_usd * creator_bps / 10_000
vault_share  = creator_fees_usd * (10_000 - X) / 10_000     // 75% buyback-burn coin / 25% the platform token applies only to realized profit, not to fees
kol_share    = creator_fees_usd * X / 10_000
protocol_fee = volume_usd * protocol_bps / 10_000            // 95 bps on curve; 93 or 5 bps on pool
```

Example, curve stage, X = 10%: $1M volume → $3,000 creator fees, of which $2,700 to the vault and $300 to the KOL.

Rough graduation context [INFERENCE from the Global constants]: initial virtual reserves are 30 SOL / 1.073e15 tokens, and 793.1M of the 1B tokens are sold on the curve. So the curve ends near **~411 SOL market cap**. A freshly migrated pool therefore starts in the 30 bps tier and moves to 95 bps once its market cap passes 420 SOL.

Note that `create_v2.creator_fee_bps` and `Global.creator_fee_configurable` only apply to "custom pairs" admitted through QuoteControl. On SOL and USDC the schedule always applies (COIN_CREATION.md arg 7; error 6091).

---

## 5. Coin metadata (`uri`) and IPFS

- `create_v2` takes `uri` (≤200 chars), pointing to a JSON document. Recommended shape (`pump-fun-skills/create-coin/references/METADATA.md`): `{ name, symbol, description, image, showName: true, createdOn, twitter?, telegram?, website?, video? }`. pump.fun itself uses `createdOn: "https://pump.fun"`.
- **pump.fun's own path (official skill):** upload the image to IPFS via **Pinata**, take its CID, build the JSON with `image: https://ipfs.io/ipfs/<cid>`, then upload the JSON to Pinata. The result is `uri = https://ipfs.io/ipfs/<metadataCid>`. Keep the Pinata JWT server-side and issue single-use presigned URLs (60 s TTL; the example caps files at 5 MB with `image/*`).
- **`https://pump.fun/api/ipfs`:** an unofficial and undocumented endpoint used by third-party tools.
  - Request: `multipart/form-data` with `file`, `name`, `symbol`, `description`, `twitter`, `telegram`, `website`, `showName`.
  - Returns `metadataUri` (third-party tutorial, e.g. [pumpdev medium](https://medium.com/@pumpdevio/how-to-create-a-token-on-pump-fun-with-javascript-complete-api-tutorial-1d5017083d97)).
  - My probe on 2026-10-04: `GET` → 405, empty `POST` → 500, so the route is alive.
  - No SLA, possible rate limits or CORS. **Use only as a fallback, called from our backend.**
- Image requirements: METADATA.md does not specify dimensions. Practical guidance: square image, jpg/png/gif/webp, ≤5 MB with our Pinata presign. pump.fun UI limits such as a "15 MB, 1000×1000 recommended" figure are [UNVERIFIED].
- Validate name ≤32 and symbol ≤10–13. COIN_CREATION.md says 13; third parties say 10, so 10 is safer.

---

## 6. Policy, mayhem mode, holder rewards

**Launching a coin "for" a KOL wallet as a third party.** The Pump program does not care: `creator` is an arbitrary non-default pubkey, and shareholders are arbitrary addresses.

pump.fun Terms ([pump.fun/docs/terms-and-conditions](https://pump.fun/docs/terms-and-conditions)) require users to "not misrepresent Creator Fee settings, token economics, or related rights to others". Public statements about creator-fee tokens "must be accurate and not misleading".

There is market precedent: UsePaid lets anyone launch a coin and route its creator fees to an arbitrary X account ([u.today](https://u.today/usepaid-pauses-x-money-payouts-after-154m-fee-surge-from-pumpfun-launches)).

Risks:
1. Impersonation or right-of-publicity complaints if the name, image or metadata suggests the KOL endorses the coin. Go.fun terms explicitly ban impersonation and right-of-publicity violations; pump.fun's main terms ban voice impersonation.
2. **CTO**: "Some Creator Fees may be subject to a community takeover… handled in the sole discretion of the Pump Entities… may be re-routed through the CTO process" (Terms). On-chain, `admin_cto` can rewrite the sharing config.

Recommendations:
- The UI and metadata should say "Copier vault tracking <wallet>: not affiliated with or endorsed by <KOL>".
- Show the fee split.
- Do not use KOL photos or handles as the token image without consent.
- Copier should monitor `AdminCtoEvent` / `ResetFeeSharingConfigEvent`.

pump.fun also has a pump-fees **social fee PDA** (`["social-fee-pda", userId, platform]`, `claim_social_fee_pda*`). It lets fees be claimed by a verified social identity. A third-party doc says only GitHub is supported [UNVERIFIED]. It could later replace "KOL wallet" as the KOL's shareholder. Not needed now.

**Holder rewards → must be false.**
- The program replaces `creator` with `holderRewardsPda(mint)` and fees go to holders.
- The creator can never be changed (6083 `HolderRewardCreatorImmutable`), so `create_fee_sharing_config` cannot run because the launcher is not the creator.
- It is permanent.

**Cashback → must be false.** It is deprecated and rejected with 6082.

**Mayhem mode → recommend false.**
- What it does (press coverage): an AI agent mints another 1B tokens (supply 2B), trades the coin for 24 h, then burns the unsold part.
- It uses the reserved fee recipients on trades, so our CPI code needs a mayhem branch.
- Mayhem is incompatible with QuoteControl quotes (6071).
- It adds noise to price and volume. It distorts the "token balance increased" heuristic only for the coin itself, which we don't copy-trade, but it distorts the coin's supply and market cap that our buyback-burn and fee-tier math use.
- Its interaction with fee sharing is untested [UNVERIFIED].
- **Upside:** the program refuses `admin_cto` on mayhem coins (6088 `CtoNotAllowedForMayhemCoin`; AMM 6075). That would make the vault's share immune to CTO. If CTO risk becomes the dominant concern, revisit this with a devnet or local test.

---

## 7. Concrete launch plan for the web app

### Accounts (SOL-quoted coin)

`mint` = new Keypair generated in the browser. It signs `create_v2` and can be vanity-ground. Derived accounts:
- `sc` = `PDA(["sharing-config", mint], PUMP_FEES)`
- `bc` = `PDA(["bonding-curve", mint], PUMP)`
- `cv` = `PDA(["creator-vault", sc], PUMP)`
- `vault` = `PDA(["vault", mint], copy-vault)`: zero data, system-owned
- `state` = `PDA(["copier", mint], copy-vault)`
- `X` = KOL bps, 100–2500

### tx1: launch (signers: launcher wallet + mint keypair; v0 + Copier platform ALT)

| # | Instruction | Key accounts |
|---|---|---|
| 0 | `ComputeBudget.setComputeUnitLimit(~350k)` + `setComputeUnitPrice` | — |
| 1 | `System.transfer(launcher → vault, Rent.minimum_balance(0))`. Optional if `register_copier` funds the vault. | launcher (s,w), vault (w) |
| 2 | **pump `create_v2`** `(name, symbol, uri, creator = launcher, is_mayhem_mode = false, [false], [0], [false])` | the 16 accounts in COIN_CREATION.md; user = launcher (s,w), mint (s,w), token_program = Token-2022 |
| 3 | **pump_fees `create_fee_sharing_config`** (no args) | event_authority, program, **payer = launcher (s,w)**, pump global, mint, sc (w), system, bc (w), pump program, pump event authority. pool / amm accounts omitted (`null` in SDK = program id placeholders). |
| 4 | **pump_fees `update_fee_shares_v2`** `([{KOL, X}, {vault, 10000−X}])` | event_authority, program, **authority = launcher (s,w)**, global, mint, sc (w), bc, cv (w), cv WSOL ATA (w), system, pump, pump EA, pump_amm, amm EA, quote_mint = WSOL, token_program = SPL Token, ATA program, amm `creator_vault(sc)` authority (w), its WSOL ATA (w). **remaining: [launcher (w)]**, the current shareholders. |
| 5 | **copier `register_copier(kol_bps)`** | launcher (s,w), mint, bc, sc, tracked_wallet, vault (w), state (init, w), copier config, system |

SDK equivalents: `PUMP_SDK.createV2Instruction`, `PUMP_SDK.createFeeSharingConfig({creator: launcher, mint, pool: null})`, `PUMP_SDK.updateFeeSharesV2({authority: launcher, mint, currentShareholders: [launcher], newShareholders, quoteMint: NATIVE_MINT, quoteTokenProgram: TOKEN_PROGRAM_ID})`.

Launch cost to the launcher (measured [MAINNET-SIM], create + config + update + 890,880 prefund): **about 0.0124 SOL**, plus priority/Jito fees and any dev buy. The `sharing_config` alone is 0.00585 SOL.

### tx2: optional dev buy (Jito bundle with tx1, or the per-launch-ALT atomic variant from §3)

`ATA.createIdempotent(launcher, mint, Token-2022)` → pump `buy_v2` with `creator_vault = cv` (not the launcher's vault), fee recipient = one of the 8 normal recipients, buyback recipient plus its ATA. `distribute_creator_fees_v2` is optional; `sweep_creator_fee` is only needed if using `buy_v3`.

### Keeper crank (permissionless, any payer)

Before graduation: `sweep_creator_fee` → `distribute_creator_fees_v2(initialize_ata=false)` with remaining accounts = shareholders in config order.
- pump accounts: payer, mint, bc, sc, cv (w), system, event_authority, program, cv WSOL ATA, WSOL, SPL Token, ATA program.

After graduation, prepend:
1. pool `sweep_creator_fee`
2. `transfer_creator_fees_to_pump_v2` (payer, WSOL, SPL Token, system, ATA program, coin_creator = sc, `creator_vault(sc)` (AMM), its WSOL ATA, cv, cv WSOL ATA, event_authority, program)

Skip the call when `get_minimum_distributable_fee` reports `canDistribute=false`; otherwise the call costs fees for a no-op.

### `register_copier`: exact checks

```text
SharingConfig (AccountInfo sc):
  sc.key == find_program_address(["sharing-config", mint], PUMP_FEES).0
  sc.owner == PUMP_FEES;  sc.data[0..8] == d84a0900388c5d4b
  sc.data[9]  == 2            // version
  sc.data[10] == 1            // status Active
  sc.data[11..43] == mint
  sc.data[75] == 1            // admin_revoked → split immutable (one-change rule consumed)
  n = u32_le(sc.data[76..80]); n == 2; sc.data.len() >= 80 + 34*n
  a0 = sc.data[80..112],  b0 = u16_le(sc.data[112..114])
  a1 = sc.data[114..146], b1 = u16_le(sc.data[146..148])
  exactly one i with a_i == tracked_wallet && b_i == kol_bps,
  the other with a_j == vault_pda && b_j == 10_000 - kol_bps
  100 <= kol_bps <= 2_500; tracked_wallet != vault_pda
  store kol_index = i       // order of remaining accounts for distribute
BondingCurve (bc):
  bc.key == find_program_address(["bonding-curve", mint], PUMP).0; bc.owner == PUMP
  bc.data[0..8] == 17b7f83760d8ac60; bc.data.len() >= 125
  bc.data[49..81] == sc.key         // creator migrated to sharing config
  bc.data[48] == 0                  // !complete (launch-time)
  bc.data[81] == 0 (mayhem per policy), bc.data[82] == 0 (cashback), bc.data[124] == 0 (holder reward)
  bc.data[83..115] == [0;32]        // SOL quote (Pubkey::default)
Mint: owner == Token-2022 program
Tracked wallet: !executable (6052 would brick distribution); require owner == System Program (normal wallet)
Vault: key == PDA(["vault", mint], copy-vault); owner == System Program; data_len == 0;
       lamports >= Rent::minimum_balance(0) (or fund it here via system transfer from launcher)
```

The `admin` field (= launcher) is informative only.

Re-verification at runtime: CTO can rewrite the config. Add a permissionless `sync_sharing_config`, or check inside the fee crank, that pauses fee-dependent logic if the vault is no longer a shareholder or `bc.creator != sc`. The keeper should also watch `AdminCtoEvent` (`sharingConfigReset`).

### Alternative design (not recommended, for completeness)

`create_v2(creator = Copier PDA)` with no sharing config:
- Fees go to `creator_vault(PDA)`. `collect_creator_fee*` and AMM `collect_coin_creator_fee` take `creator` / `coin_creator` as **non-signers**, so they are permissionless.
- Copier would split X% to the KOL itself.
- Saves 0.0059 SOL and about 2 instructions.
- Downsides: no on-chain or pump.fun-visible split; AMM fees arrive as WSOL in an ATA we must unwrap; CTO risk is the same.

---

## Open items / [UNVERIFIED]

- `pump.fun/api/ipfs` response format and limits as of today (route alive, not exercised with a real upload). pump.fun UI image limits.
- Whether the pump.fun UI displays fee-share recipients or the deployer for fee-shared coins.
- Mayhem + fee-sharing interaction, untested. CTO immunity is inferred from error codes 6088 / 6075 only.
- Exact semantics of `Global.buyback_basis_points` (5000).
- Policy enforcement against "fan" or KOL-named coins: discretionary, with no explicit rule found beyond misrepresentation and impersonation clauses.

## Sources

- Local docs:
  - `.research/pump-public-docs/docs/{FEE_PROGRAM_README,PUMP_CREATOR_FEE_README,PUMP_SWAP_CREATOR_FEE_README,BREAKING_FEE_RECIPIENT,HOLDER_REWARDS_README,FAQ,FEE_RECIPIENTS}.md`
  - `docs/instructions/{CREATOR_FEE_SHARING,COIN_CREATION}.md`
  - `idl/{pump,pump_amm,pump_fees}.json`
- Skills:
  - `.research/pump-fun-skills/coin-fees/{SKILL.md,scripts/*}`
  - `.research/pump-fun-skills/create-coin/{SKILL.md,references/METADATA.md,scripts/*}`
- npm `@pump-fun/pump-sdk@2.0.0`: `src/sdk.ts` (createV2Instruction 1048, createFeeSharingConfig 2723, updateFeeSharesV2 2878, distributeCreatorFeesV2 3062, isSharingConfigEditable 3445, adminCto docs 1819), `src/state.ts`, `src/pda.ts`.
- npm `@pump-fun/pump-swap-sdk@1.20.0`.
- crates.io `pump-rust-client@0.2.0`: `README.md`, `idls/`, `src/sdk/pump_v3.rs`, `src/sdk/pump_v2.rs` (via PumpCpiResearch's download in `%TEMP%/pumpres`).
- On-chain reads: pump Global `4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf`, FeeConfigs `8Wf5Ti…`, `5PHirr…`; mainnet `getMinimumBalanceForRentExemption`.
- Web:
  - [crypto.news 2026-03-25](https://crypto.news/pump-fun-limits-fee-wallet-edits-as-revenue-and-volume-fall/)
  - [CoinMarketCap Academy](https://coinmarketcap.com/academy/article/pumpdotfun-caps-creator-fee-changes-to-one-per-token)
  - [pump.fun Terms](https://pump.fun/docs/terms-and-conditions)
  - [Go.fun Terms](https://pump.fun/docs/go-fun-terms)
  - [Solana reduced rent / SIMD-0437](https://solana.com/upgrades/reduced-rent)
  - [UsePaid precedent](https://u.today/usepaid-pauses-x-money-payouts-after-154m-fee-surge-from-pumpfun-launches)
  - Mayhem coverage: [KuCoin](https://www.kucoin.com/news/flash/pump-fun-launches-mayhem-mode-with-ai-agents-to-boost-meme-token-trading), [Cryptopolitan](https://www.cryptopolitan.com/pump-fun-launches-mayhem-mode-letting-ai-agents-loose-in-the-trenches/)
