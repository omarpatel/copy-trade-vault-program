# copy-vault × pump.fun / PumpSwap: CPI trading from an Anchor 0.31 program with a PDA signer

Research date: 2026-10-04. Author: PumpCpiResearch.

**Sources used.** Local docs clone `.research/pump-public-docs` (HEAD `cb188ce`, 2026-09-29), `.research/pump-fun-skills`, the crate `pump-rust-client` 0.2.0 (crates.io, published 2026-09-29; its `idls/` are **newer** than the public-docs IDLs), and npm `@pump-fun/pump-sdk` 2.0.0 and `@pump-fun/pump-swap-sdk` 1.20.0 sources. I also read live **mainnet** state over RPC.

**Verified on a mainnet fork.** I ran a solana-test-validator 4.2.1 that cloned the mainnet pump, pump_amm and pump_fees programs plus the needed accounts. I built a throwaway Anchor 0.31.1 wrapper (`probe`) that CPIs with a **system-owned PDA as `user`**. All throwaway code is outside the repo, in `%TEMP%\pumpres` and WSL `/root/copier-pumpcpi-probe`.

---

## 0. Things that change the architecture

1. **A PDA works as `user` (verified end-to-end).** A system-owned, zero-data PDA signing via `invoke_signed` can be `user` for all of these:
   - pump `buy_v2`, `sell_v2`, `buy_v3`, `sell_v3`;
   - pump_amm `buy_exact_quote_in` (v1) and `sell` (v1);
   - pump_amm `buy_exact_quote_in_v2` and `sell_v2`.

   Pump also initialised `user_volume_accumulator` for that PDA and charged the rent to it. The vault's lamports went 2,000,000,000 → 1,947,631,080 on the first 0.05-SOL buy. That includes UVA rent of about 0.00184 SOL. See §8 for the logs.
2. **Undocumented trade instructions are already live on mainnet.** These exist in pump-rust-client 0.2.0 but are missing from the public docs and from the npm SDKs:
   - pump: `buy_v3`, `sell_v3`, `buy_exact_quote_in_v3`, `sweep_creator_fee`;
   - pump_amm: `buy_v2`, `sell_v2`, `buy_exact_quote_in_v2`, `sweep_creator_fee`.

   **How I checked they are live:** I simulated each discriminator on mainnet and devnet with zero accounts. Each one returned `AccountNotEnoughKeys (3005)`, while a bogus discriminator returned `InstructionFallbackNotFound (101)`. They also succeeded end-to-end on the mainnet fork.

   **What v3 changes:** each trade takes **17 accounts and no fee recipients**. The protocol fee (minus its buyback slice) and the creator fee build up in new buckets on the `BondingCurve` / `Pool` until someone sweeps them. The buckets are `BondingCurve.creator_fee` / `protocol_fees` and `Pool.creator_fees` / `protocol_fees`. A live mainnet curve already shows non-zero buckets (`creator_fee = 8,209,520`, `protocol_fees = 12,527,937` lamports on curve `Cv5m3RSz…`), so third parties are already using v3.

   **Consequence for fee sharing:** you must call `sweep_creator_fee` (disc `20f6bf3408c949ba`) **in the same tx** before `distribute_creator_fees*`, `update_fee_shares*` or `admin_cto`. Otherwise those calls fail with `CreatorFeesNotSwept` (6095). Source: crate `README.md` §"Bonding curve v3"; error from crate `idls/pump.json`.
3. **v3 is the cheapest and most stable target for copy-vault's own CPIs.** Compared with v2:
   - about 40% fewer CUs and 17 accounts instead of 27;
   - it fits in a v0 tx with no ALT;
   - it needs no fee-recipient selection and no creator-vault derivation.

   v2 still works and is what the docs announce. Cashback coins stay on v2, but cashback is deprecated and `create_v2` can no longer make cashback coins.
4. **On a fee-sharing coin, `BondingCurve.creator` is the `sharing_config` PDA** (verified on a mainnet coin). So `creator_vault = PDA(["creator-vault", sharing_config], pump)`. Always derive `creator_vault` from the on-chain `bonding_curve.creator`; never derive it from the launcher's wallet.

---

## 1. Program IDs and fee recipients

| Item | Address | Source |
|---|---|---|
| pump (bonding curve) | `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` | `docs/PUMP_PROGRAM_README.md`, `idl/pump.json` |
| pump_amm (PumpSwap) | `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA` | `docs/PUMP_SWAP_README.md`, `idl/pump_amm.json` |
| pump_fees | `pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ` | `idl/pump_fees.json`, crate `src/constants.rs` |
| mayhem program | `MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e` | crate `src/constants.rs` (`MAYHEM_PROGRAM_ID`) |
| pump Global PDA `["global"]` | `4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf` | docs + RPC |
| pump FeeConfig PDA `["fee_config", pump_id]` @ pump_fees | `8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt` | RPC |
| pump_amm GlobalConfig `["global_config"]` | `ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw` | docs |
| pump_amm FeeConfig `["fee_config", pump_amm_id]` @ pump_fees | `5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx` | computed + RPC |
| pump global_volume_accumulator | `Hq2wp8uJ9jCPsYgNHex8RtqdvMPfVGoYwjvF1ATiwn2Y` | computed |
| Token-2022 / SPL Token / ATA | `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` / `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` / `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL` | |
| Pump ALT, frozen, 43 addrs | `7mFD2mUtRS65XstiSAvCJuYmdesZoQwCwRJhq1p3eRMe` | `pump-fun-skills/swap/scripts/lib/constants.mjs`; RPC shows authority = none |
| Pump ALT, mutable, 183 addrs | `Hyif6eWb8x88RVrvjPfabsgRYnwkVnyByEXTVTXbUcyP` (authority `92gWFZ…`) | crate `MAINNET_ALT` |

**Fee recipients.** There are 24 in total; see `docs/FEE_RECIPIENTS.md`. They match the live `Global` / `GlobalConfig` (RPC read today).

- **Normal fee recipients** (pump `fee_recipient` for non-mayhem coins):
  - `62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV`
  - `7VtfL8fvgNfhz17qKRMjzQEXgbdpnHHHQRh54R9jP2RJ`
  - `7hTckgnGnLQR6sdH7YkqFTAA7VwTfYFaZ6EhEsU3saCX`
  - `9rPYyANsfQZw3DnDmKE3YCQF5E8oD89UXoHn9JFEhJUz`
  - `AVmoTthdrX6tKt4nDjco2D775W2YK3sDhxPcMmzUAmTY`
  - `CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM`
  - `FWsW1xNtWscwNmKv6wVsU1iTzRN6wmmk3MjxRP5tT7hz`
  - `G5UZAVbAf46s7cKWoyKu8kYTip9DGTpbLZ2qa9Aq69dP`

  These are `Global.fee_recipient` plus the 7 entries of `Global.fee_recipients`.
- **Reserved fee recipients** (pump `fee_recipient` for **mayhem** coins):
  - `GesfTA3X2arioaHp8bbKdjG9vJtskViWACZoYvxp4twS`
  - `4budycTjhs9fD6xw62VBducVTNgMgJJ5BgtKq7mAZwn6`
  - `8SBKzEQU4nLSzcwF4a74F2iaUDQyTfjGndn6qUWBnrpR`
  - `4UQeTP1T39KZ9Sfxzo3WR5skgsaP6NZa87BAkuazLEKH`
  - `8sNeir4QsLsJdYpc9RZacohhK1Y5FLU3nC5LXgYB4aa6`
  - `Fh9HmeLNUMVCvejxCtCL2DbYaRyBFVJ5xrWkLnMH6fdk`
  - `463MEnMeGyJekNZFQSTUABBEbLnvMTALbT6ZmsxAbAdq`
  - `6AUH3WEHucYZyC61hqpqYUWVto5qA5hjHuNQ32GNnNxA`

  Passing a normal recipient on a mayhem coin fails with `NotAuthorized` 6000 at `fee_recipient.rs:19` (observed in a mainnet simulation).
- **Buyback fee recipients** (all coins, pump and pump_amm):
  - `5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD`
  - `9M4giFFMxmFGXtc3feFzRai56WbBqehoSeRE5GK7gf7`
  - `GXPFM2caqTtQYC2cJ5yJRi9VDkpsYZXzYdwYpGnLmtDL`
  - `3BpXnfJaUTiwXnJNe7Ej1rcbzqTTQUvLShZaWazebsVR`
  - `5cjcW9wExnJJiqgLjq7DEG75Pm6JBgE1hNv4B2vHXUW6`
  - `EHAAiTxcdDwQ3U4bU6YcMsQGaekdzLS3B5SmYo46kJtL`
  - `5eHhjP8JaYkz83CWwvGU2uMUXefd3AazWGx4gpcuEEYD`
  - `A7hAgCzFw14fejgCp387JUJRMNyz4j89JKnhtKU8piqW`

  These are `Global.buyback_fee_recipients` / `GlobalConfig.buyback_fee_recipients`. `BREAKING_FEE_RECIPIENT.md` introduced them on Apr 28.
- **PumpSwap protocol fee recipients** (`GlobalConfig.protocol_fee_recipients`, live): the 8 normal ones **except** `CebN5…`, plus `JCRGumoE9Qi5BBgULTgdgTLjSgkCMSbF62ZZfGs84JeU`. Pick at random to spread write locks (`PUMP_SWAP_README.md`).
- **`buyback_basis_points` = 5000** on both programs (live). The buyback slice is part of the protocol fee and is not an extra charge on the trader. [UNVERIFIED: the exact split formula. The crate tests only assert "buyback paid".]

---

## 2. pump bonding-curve trade instructions

Anchor discriminator = `sha256("global:<name>")[..8]`. Every value below was recomputed and matches the IDL. Flags: **W** = writable, **S** = signer.

### 2.1 Discriminators and arguments

| ix | disc (hex) | args (borsh, after the disc) | accounts |
|---|---|---|---|
| `buy` (legacy) | `66063d1201daebea` | `amount u64, max_sol_cost u64, track_volume OptionBool(u8)` [+ `partial_fill OptionBool` in the crate IDL] | 16 IDL accounts + remaining `bonding_curve_v2` (R) and `buyback_fee_recipient` (W) = 18 |
| `buy_exact_sol_in` (legacy) | `38fc74089edfcd5f` | `spendable_sol_in u64, min_tokens_out u64, track_volume OptionBool` [+ `partial_fill`] | same as `buy` |
| `sell` (legacy) | `33e685a4017f83ad` | `amount u64, min_sol_output u64` | 14 + remaining (cashback: UVA), `bonding_curve_v2`, buyback |
| **`buy_v2`** | `b817ee6167c5d33d` | `amount u64, max_sol_cost u64` [+ optional trailing `partial_fill OptionBool`; both 24- and 25-byte data accepted on mainnet] | 27 |
| **`sell_v2`** | `5df6823ce7e940b2` | `amount u64, min_sol_output u64` | 26 |
| **`buy_exact_quote_in_v2`** (the exact-SOL-in v2) | `c2ab1c46684d5b2f` | `spendable_quote_in u64, min_tokens_out u64` [+ `partial_fill`] | 27, same order as `buy_v2` |
| **`buy_v3`** | `07051dc4f5176550` | `amount u64, max_sol_cost u64, partial_fill OptionBool` | 17 |
| **`sell_v3`** | `1c92de7726c469d5` | `amount u64, min_sol_output u64` | 17 |
| **`buy_exact_quote_in_v3`** | `e1f7501ed5b38488` | `spendable_quote_in u64, min_tokens_out u64, partial_fill OptionBool` | 17 |
| `sweep_creator_fee` | `20f6bf3408c949ba` | none | 13 (payer S, global, base_mint, quote_mint, quote_token_program, ATA prog, system, bonding_curve W, assoc_quote_bonding_curve W, recipient W, assoc_quote_recipient W, event_authority, program) |

Other pump discriminators you may need to whitelist or blacklist:
- `create_v2` `d6904cec5f8b31b4`
- `extend_account` `ea66c2cb96483ee5`
- `init_user_volume_accumulator` `5e06ca73ff60e8b7`
- `close_user_volume_accumulator` `f945a4da9667548a`
- `distribute_creator_fees_v2` `ffcb134ff444089f`
- `migrate` `9beae792ec9ea21e`
- Anchor event-CPI tag `e445a52e51cb9a1d`

`OptionBool` is a struct holding one `bool`, so it is exactly 1 byte. A legacy `buy` ix data is `disc + 16 + 1 (+1)` bytes.

**Answer to "does a v2 exact-SOL-in exist?"** Yes: `buy_exact_quote_in_v2`. The docs mention it in `README.md`, the IDL has it, and it was seen on mainnet. The v3 equivalent is `buy_exact_quote_in_v3`. Fees are taken out of `spendable_quote_in` (see §4).

### 2.2 `buy_v2` account order (27)

Sources: `idl/pump.json`, `docs/instructions/BUY.md`.

| # | account | W | S | derivation |
|---|---|---|---|---|
| 0 | global | | | `["global"]` |
| 1 | base_mint | | | Token-2022 mint for `create_v2` coins |
| 2 | quote_mint | | | **wSOL `So111…112` for SOL coins**, even though trades move native SOL |
| 3 | base_token_program | | | Token-2022 (create_v2) or SPL Token (legacy `create`); use the mint's owner |
| 4 | quote_token_program | | | SPL Token for wSOL |
| 5 | associated_token_program | | | `ATokenGP…` |
| 6 | fee_recipient | W | | normal recipient, or reserved if `is_mayhem_mode` |
| 7 | associated_quote_fee_recipient | W | | ATA(fee_recipient, quote_mint, quote_tp). Seed-checked only for SOL coins; no need to init |
| 8 | buyback_fee_recipient | W | | one of the 8 buyback wallets |
| 9 | associated_quote_buyback_fee_recipient | W | | ATA(buyback, quote) |
| 10 | bonding_curve | W | | `["bonding-curve", base_mint]` |
| 11 | associated_base_bonding_curve | W | | ATA(bonding_curve, base_mint, base_tp) |
| 12 | associated_quote_bonding_curve | W | | ATA(bonding_curve, quote_mint, quote_tp) |
| **13** | **user** | **W** | **S** | **vault PDA (invoke_signed)** |
| 14 | associated_base_user | W | | ATA(user, base_mint, base_tp). **Must already exist** (the SDK prepends an idempotent create) |
| 15 | associated_quote_user | W | | ATA(user, quote). Seed-checked only for SOL coins |
| 16 | creator_vault | W | | `["creator-vault", bonding_curve.creator]` |
| 17 | associated_creator_vault | W | | ATA(creator_vault, quote) |
| 18 | sharing_config | | | `["sharing-config", base_mint]` @ pump_fees |
| 19 | global_volume_accumulator | | | `["global_volume_accumulator"]` |
| 20 | user_volume_accumulator | W | | `["user_volume_accumulator", user]`. **init_if_needed, paid by user**: 137 bytes, ≈0.0018444 SOL |
| 21 | associated_user_volume_accumulator | W | | ATA(UVA, quote) |
| 22 | fee_config | | | `["fee_config", pump_id]` @ pump_fees = `8Wf5…` |
| 23 | fee_program | | | pump_fees |
| 24 | system_program | | | |
| 25 | event_authority | | | `["__event_authority"]` |
| 26 | program | | | pump |

**`sell_v2` (26 accounts)** has the same order but **drops `global_volume_accumulator`**. So indices 0–18 are the same, then:
19 user_volume_accumulator W, 20 associated_user_volume_accumulator W, 21 fee_config, 22 fee_program, 23 system_program, 24 event_authority, 25 program.
`user` stays at index 13.

### 2.3 `buy_v3` / `sell_v3` / `buy_exact_quote_in_v3` account order (17, identical for all three)

Source: crate `idls/pump.json`, `src/sdk/pump_v3.rs`.

| # | account | W | S | note |
|---|---|---|---|---|
| 0 | global | | | |
| 1 | base_mint | | | |
| 2 | quote_mint | | | wSOL (or default) for SOL curves |
| 3 | base_token_program | | | |
| 4 | quote_token_program | | | |
| 5 | bonding_curve | W | | |
| 6 | associated_base_bonding_curve | W | | |
| 7 | associated_quote_bonding_curve | W | | |
| **8** | **user** | **W** | **S** | vault PDA |
| 9 | associated_base_user | W | | |
| 10 | associated_quote_user | W | | |
| 11 | user_volume_accumulator | W | | init_if_needed, paid by user |
| 12 | fee_config | | | |
| 13 | buyback_fee_recipient | W | | **SOL curve: the wallet itself. Token quote: the wallet's quote ATA, which must already exist** |
| 14 | system_program | | | |
| 15 | event_authority | | | |
| 16 | program | | | |

The crate notes that "v3 prices exactly like v2" and that cashback coins stay on v2.

### 2.4 Constraints on `user`, all verified on the mainnet fork

- **A PDA can be `user`.** Pump accepts a PDA that signs via `invoke_signed`. Nothing requires it to be on-curve.
- **The PDA must be System-owned with zero data.** For SOL coins, pump moves the purchase price and fees out of `user` with System `transfer`, and it creates the UVA with `user` as payer (`create_account` / transfer + allocate + assign). The System program rejects a `from` account that carries data ("Transfer: `from` must not carry data"; agave `programs/system/src/system_processor.rs`). [INFERENCE from the System program rules. Only the zero-data case was tested, and it works.] So: **use a dedicated lamport-only vault PDA, e.g. `["vault", copier]`, owned by the System program, and keep all state in a separate PDA.**
- **Stay rent-exempt.** The vault must stay ≥ 890,880 lamports (rent-exempt minimum for 0 bytes) after every trade. [INFERENCE: standard runtime rule.]
- **Sells pay lamports straight to `user`.** On a SOL-coin sell, pump credits lamports directly to the vault (observed: vault lamports rose on `sell_v2` / `sell_v3`). No wSOL is involved.
- **One-time and per-trade rent the vault pays:**
  - UVA rent on its first buy (pump and pump_amm each have their own UVA);
  - its own base ATAs (Token-2022 ATA = 170 bytes ≈ 0.00207408 SOL; the keeper can pay this instead);
  - possible top-ups of `creator_vault` and fee-recipient quote ATAs (docs: "Rent-exempt top-up if needed").

  Budget for these in the lamport-delta cap.

---

## 3. PumpSwap (pump_amm) trade instructions

### 3.1 Discriminators

| ix | disc | args | accounts |
|---|---|---|---|
| `buy` | `66063d1201daebea` | `base_amount_out u64, max_quote_amount_in u64, track_volume OptionBool` | 23 + remaining |
| `buy_exact_quote_in` | `c62e1552b4d9e870` | `spendable_quote_in u64, min_base_amount_out u64, track_volume OptionBool` | 23 + remaining |
| `sell` | `33e685a4017f83ad` | `base_amount_in u64, min_quote_amount_out u64` | 21 + remaining |
| **`buy_v2`** | `b817ee6167c5d33d` | `base_amount_out u64, max_quote_amount_in u64` | 17 |
| **`buy_exact_quote_in_v2`** | `c2ab1c46684d5b2f` | `spendable_quote_in u64, min_base_amount_out u64` | 17 |
| **`sell_v2`** | `5df6823ce7e940b2` | `base_amount_in u64, min_quote_amount_out u64` | 17 |

**Warning:** pump and pump_amm share the discriminators for `buy`/`sell`/`buy_v2`/`sell_v2`/`buy_exact_quote_in_v2`. A whitelist must therefore be keyed on **(program_id, discriminator)**.

### 3.2 Legacy `buy` / `buy_exact_quote_in` (23 IDL accounts)

| # | account | flags | note |
|---|---|---|---|
| 0 | pool | W | |
| **1** | **user** | **W S** | |
| 2 | global_config | | |
| 3 | base_mint | | |
| 4 | quote_mint | | |
| 5 | user_base_token_account | W | |
| 6 | user_quote_token_account | W | **wSOL token account** |
| 7 | pool_base_token_account | W | |
| 8 | pool_quote_token_account | W | |
| 9 | protocol_fee_recipient | | |
| 10 | protocol_fee_recipient_token_account | W | its wSOL ATA |
| 11 | base_token_program | | |
| 12 | quote_token_program | | |
| 13 | system_program | | |
| 14 | associated_token_program | | |
| 15 | event_authority | | |
| 16 | program | | |
| 17 | coin_creator_vault_ata | W | ATA(coin_creator_vault_authority, quote) |
| 18 | coin_creator_vault_authority | | `["creator_vault", pool.coin_creator]` (**underscore** here vs the hyphen in pump) |
| 19 | global_volume_accumulator | | |
| 20 | user_volume_accumulator | W | init_if_needed, paid by user |
| 21 | fee_config | | `5PHi…` |
| 22 | fee_program | | |

Remaining accounts, in this order (crate `src/sdk/pump_amm_ix.rs`):
1. **cashback coins only:** ATA(UVA, quote) W;
2. **if `pool.coin_creator != default`:** `pool_v2` PDA `["pool-v2", base_mint]` (read-only);
3. `buyback_fee_recipient` (W on buy);
4. ATA(buyback, quote) W.

Legacy `sell` (21 IDL accounts) is the same but drops indices 19–20, so `fee_config` is at 19 and `fee_program` at 20. Its remaining accounts are:
- cashback coins: ATA(UVA, quote) W **and** UVA W;
- `pool_v2` (R);
- buyback (**R** on sell);
- buyback ATA (W).

**Crate caveat:** the legacy AMM path only reads the cashback/`pool_v2` remaining accounts **when the trade's creator fee is non-zero**. When the fee rounds to 0 it expects the buyback recipient first, and the trade fails with `BuybackFeeRecipientNotAuthorized`. That fragility is another reason to use v2.

### 3.3 v2 (`buy_v2` / `buy_exact_quote_in_v2` / `sell_v2`): 17 accounts, identical for all three, no remaining accounts

| # | account | flags | note |
|---|---|---|---|
| 0 | pool | W | |
| **1** | **user** | **W S** | |
| 2 | global_config | | |
| 3 | base_mint | | |
| 4 | quote_mint | | |
| 5 | user_base_token_account | W | |
| 6 | user_quote_token_account | W | wSOL |
| 7 | pool_base_token_account | W | |
| 8 | pool_quote_token_account | W | |
| 9 | base_token_program | | |
| 10 | quote_token_program | | |
| 11 | system_program | | |
| 12 | user_volume_accumulator | W | |
| 13 | fee_config | | |
| 14 | `buyback_fee_recipient` | W | **the buyback wallet's quote (wSOL) ATA**, which must exist |
| 15 | event_authority | | |
| 16 | program | | |

There is no creator vault and no protocol fee recipient. The creator and protocol fees accrue in `Pool.creator_fees` / `Pool.protocol_fees` until `sweep_pool_creator_fee`.

### 3.4 wSOL handling

PumpSwap always moves the quote as an SPL token. For SOL pools, `user_quote_token_account` must be a **wSOL token account owned by `user`** (normally the ATA under SPL Token). PumpSwap does **not** wrap for you. The npm SDK `buyQuoteInput` emits five instructions: System transfer → ATA create → `syncNative` → `buy` → `closeAccount`. The Rust auto-router `trade_tx_instructions` wraps and unwraps the same way.

For a PDA vault, copy-vault's program must do this itself:
1. `system_program::transfer` (vault → vault wSOL ATA, signed with `invoke_signed`), then `token::sync_native`.
2. After sells, either keep the wSOL as an AMM quote balance or unwrap with `close_account` (authority = vault, destination = vault) and recreate the account later. You cannot partially unwrap.
3. Count the vault's NAV / high-water mark as **lamports + wSOL balance**.

Verified: the keeper funded the vault's wSOL ATA, then proxied AMM trades all moved the vault's wSOL with the vault PDA as `user`.

---

## 4. Layouts and quote math

### 4.1 `BondingCurve`

- Discriminator: `17b7f83760d8ac60`.
- Live accounts are 151 bytes.
- Older accounts can be shorter: read missing trailing fields as 0 / false / default (`PUMP_PROGRAM_README.md`).

| off | field | type |
|---|---|---|
| 8 | virtual_token_reserves | u64 |
| 16 | virtual_quote_reserves (was virtual_sol_reserves) | u64 |
| 24 | real_token_reserves | u64 |
| 32 | real_quote_reserves (was real_sol_reserves) | u64 |
| 40 | token_total_supply | u64 |
| 48 | complete | bool |
| 49 | creator | Pubkey (= sharing_config PDA once fee sharing is set up) |
| 81 | is_mayhem_mode | bool |
| 82 | is_cashback_coin | bool |
| 83 | quote_mint | Pubkey (`default` for SOL coins) |
| 115 | creator_fee_bps | u64 (0 = use the schedule) |
| 123 | can_edit_creator_fee | bool |
| 124 | is_holder_reward | bool |
| 125 | creator_fee (v3 un-swept bucket) | u64 — crate IDL only |
| 133 | protocol_fees (v3 un-swept bucket) | u64 — crate IDL only |

Live read of `Cv5m…` matched these offsets: vtok 532,583,685,232,434; vquote 60,441,208,005; supply 1e15; creator = sharing_config.

### 4.2 `Pool` (pump_amm)

- Discriminator: `f19a6d0411b16dbc`.
- Live accounts are 300 bytes.

| off | field | type |
|---|---|---|
| 8 | pool_bump | u8 |
| 9 | index | u16 |
| 11 | creator | Pubkey (canonical pools: pump `["pool-authority", mint]`) |
| 43 | base_mint | Pubkey |
| 75 | quote_mint | Pubkey |
| 107 | lp_mint | Pubkey |
| 139 | pool_base_token_account | Pubkey |
| 171 | pool_quote_token_account | Pubkey |
| 203 | lp_supply | u64 |
| 211 | coin_creator | Pubkey |
| 243 | is_mayhem_mode | bool |
| 244 | is_cashback_coin | bool |
| 245 | virtual_quote_reserves | **i128, may be negative since Sept 30** |
| 261 | creator_fee_bps | u64 |
| 269 | can_edit_creator_fee | bool |
| 270 | is_holder_reward | bool |
| 271 | protocol_fees | u64 — crate only |
| 279 | creator_fees | u64 — crate only |

Canonical pool address = `["pool", 0u16 LE, pool_authority, base_mint, wSOL]` (npm `canonicalPumpPoolPda`).

**Pricing:**
- `effective_quote = vault.amount + virtual_quote_reserves`, added as i128 and cast to u64 (guaranteed non-negative; `NEGATIVE_VIRTUAL_QUOTE_RESERVES.md`).
- After v2 trades, sells are paid from `vault.amount − (protocol_fees + creator_fees)`.
- Crate `math/amm.rs`: "`virtual_quote_reserves` = boost sigma minus un-swept buckets".

### 4.3 `Global` (pump) and `GlobalConfig` (pump_amm)

**pump `Global`** — discriminator `a7e8e8b1c86c727f`, 1087 bytes:

| off | field |
|---|---|
| 8 | initialized |
| 9 | authority |
| 41 | fee_recipient |
| 73 | initial_virtual_token_reserves |
| 81 | initial_virtual_sol_reserves |
| 89 | initial_real_token_reserves |
| 97 | token_total_supply |
| 105 | fee_basis_points |
| 113 | withdraw_authority |
| 145 | enable_migrate |
| 146 | pool_migration_fee |
| 154 | creator_fee_basis_points |
| 162 | fee_recipients [7] |
| 386 | set_creator_authority |
| 418 | admin_set_creator_authority |
| 450 | create_v2_enabled |
| 451 | whitelist_pda |
| 483 | reserved_fee_recipient |
| 515 | mayhem_mode_enabled |
| 516 | reserved_fee_recipients [7] |
| 740 | is_cashback_enabled |
| 741 | buyback_fee_recipients [8] |
| 997 | buyback_basis_points |
| 1005 | initial_virtual_quote_reserves |
| 1013 | whitelisted_quote_mints [1] |
| 1045 | creator_fee_configurable |
| 1046 | max_configurable_creator_fee_bps |
| 1054 | holder_reward_claim_authority |
| 1086 | is_holder_reward_enabled |

**pump_amm `GlobalConfig`** — discriminator `95089ccaa0fcb0d9`:

| off | field |
|---|---|
| 8 | admin |
| 40 | lp_fee_basis_points |
| 48 | protocol_fee_basis_points |
| 56 | disable_flags (bit 3 = buy off, bit 4 = sell off) |
| 57 | protocol_fee_recipients [8] |
| 313 | coin_creator_fee_basis_points |
| 321 | admin_set_coin_creator_authority |
| 353 | whitelist_pda |
| 385 | reserved_fee_recipient |
| 417 | mayhem_mode_enabled |
| 418 | reserved_fee_recipients [7] |
| 642 | is_cashback_enabled |
| 643 | buyback_fee_recipients [8] |
| 899 | buyback_basis_points |
| 907 | boost_authority |
| 939 | boost_enabled |
| 940 | creator_fee_configurable |
| 941 | max_configurable_creator_fee_bps |

**`FeeConfig`** (pump_fees, discriminator `8f3492bbdb7b4c9b`):
- `bump u8`, `admin Pubkey`, `flat_fees Fees{lp,protocol,creator u64}`
- `fee_tiers Vec<FeeTier{market_cap_lamports_threshold u128, fees Fees}>`
- `stable_fee_tiers Vec<FeeTier>`, `exotic_flat_fees Fees`

The fields are variable-length, so decode them in order with borsh.

### 4.4 Fees: which bps apply

Source: crate `src/math/fees.rs`, which copiers the program; also `FEE_PROGRAM_README.md`.

- **The bps come from `FeeConfig`, not `Global`.** `Global` / `GlobalConfig` bps fields "play no part in on-chain pricing". The live `Global.fee_basis_points` = 95 and `creator_fee_basis_points` = 5 are ignored.
- **Market cap used to pick a tier:**
  - curve: `mcap = virtual_quote_reserves * supply / virtual_token_reserves`;
  - pool: `mcap = quote_reserve * base_mint_supply / base_reserve`.
  - `supply` is the **live mint supply**, except mayhem coins, which use `token_total_supply`.
  - Our buyback burns reduce live supply, so they slightly lower the computed mcap.
- **Which schedule applies:**
  - non-canonical pools pay `flat_fees`;
  - SOL-like quote (default key, wSOL, Token-2022 native) pays `fee_tiers`;
  - USDC pays `stable_fee_tiers`;
  - any other quote pays `exotic_flat_fees`, or `flat_fees` if exotic is all zero.
- **Tier selection:** take the highest tier with `threshold <= mcap`; if mcap is below the first threshold, use the first tier.
- **Per-coin override:** a non-zero coin `creator_fee_bps` replaces the schedule's creator bps while `creator_fee_configurable` is on.
- **No creator → no creator fee:** the creator fee is 0 if the creator is the default key.

**Live mainnet values today:**
- **Curve** (pump FeeConfig `8Wf5…`): one tier at threshold 0 → **protocol 95 bps + creator 30 bps = 1.25%**, LP 0.
- **PumpSwap canonical pools** (FeeConfig `5PHi…`), as lp / protocol / creator bps:

  | threshold (lamports) | lp | protocol | creator |
  |---|---|---|---|
  | 0 | 2 | 93 | 30 |
  | 420e9 | 20 | 5 | 95 |
  | 1470e9 | 20 | 5 | 90 |
  | … | 20 | 5 | creator steps down |
  | 98240e9 | 20 | 5 | 5 |

  This matches `docs/fees.png`.
- Non-canonical pools pay flat lp 25 / protocol 5 / creator 0.

**Math.** All products are u128; `fee(x, bps) = ceil(x*bps/10_000)`.

- **Curve buy, exact tokens (`buy_v2` / `buy_v3`):**
  ```text
  cost = floor(n * vQ / (vT - n)) + 1
  total = cost + fee(cost, protocol_bps) + fee(cost, creator_bps)
  ```
  `n` is capped at `real_token_reserves`. `max_sol_cost` must be ≥ `total`.
- **Curve buy, exact SOL in (`buy_exact_quote_in_v2` / `_v3`):**
  ```text
  net = floor(in * 10_000 / (10_000 + Σbps))
  if net + Σ fee(net, bps_i) > in:  net -= the excess
  tokens = floor((net - 1) * vT / (vQ + net - 1))
  ```
  `tokens` is capped at `real_token_reserves`.
- **Curve sell:**
  ```text
  out = floor(n * vQ / (vT + n))
  receive = out - fee(out, protocol_bps) - fee(out, creator_bps)
  ```
- **AMM:** the same constant-product formulas on `(base_reserve, effective_quote)`, with three fee components (lp, protocol, creator).
  - Buy, exact base out: `raw = ceil(Q*b / (B - b))`, then `total = raw + lp + protocol + creator`.
  - Exact-quote-in uses the same `net` derivation as the curve (`swap_exact_input(net - 1)`).
  - Sell: `raw = floor(Q*b / (B + b))`, then `out = raw - fees`. It also requires `real_quote ≥ raw - lp`.
- **`partial_fill`:** a buy bigger than the remaining curve fills only the remainder and completes the curve. The v2/v3 builders send `partial_fill = true`.

**Quoting helpers:**
- npm `@pump-fun/pump-sdk`: `getBuyTokenAmountFromSolAmount`, `getBuySolAmountFromTokenAmount`, `getSellSolAmountFromTokenAmount`, `computeFeesBps`, `calculateFeeTier`, `bondingCurveMarketCap`.
- npm `@pump-fun/pump-swap-sdk`: `buyBaseInput`, `buyQuoteInput`, `sellBaseInput`, `sellQuoteInput`.
- Rust `pump-rust-client`: `PumpSdk::buy_quote_bonding_curve_sol_in`, `buy_quote_bonding_curve_token_out`, `sell_quote_bonding_curve`, `buy_quote_amm_*`, `sell_quote_amm`, `quote_trade`, `math::*`.

These are pure integer math and usable on-chain. Recommendation: let the program read `vT` / `vQ` (curve offsets 8 / 16) or the pool vaults, compute the quote itself, and enforce a `min_out` slippage bound. That stops a keeper from sandwiching the vault.

---

## 5. SDKs and crates

### Rust: `pump-rust-client` 0.2.0

- Official: pump's `README.md` links `https://crates.io/crates/pump-rust-client`.
- crates.io lists 14 versions, 0.1.0 (2026-05-04) to **0.2.0 (2026-09-29)**. The crate metadata has no repository link.
- `rust-version` 1.89; MIT licence.
- **Dependencies:**
  - `anchor-lang >=0.31, <2` (features event-cpi, init-if-needed, allow-missing-optionals);
  - `anchor-spl >=0.31, <2` (metadata, token_2022, token_2022_extensions, …);
  - `solana-program >=2.1.21`;
  - optional `client` feature: solana-sdk / solana-client `<3`.
- **Contents:**
  - `declare_program!` modules `pump`, `pump_amm`, `pump_agent_payments` (no `pump_fees` module);
  - `state::*` wrappers that zero-pad short legacy accounts, so `Account<'info, BondingCurve>` works on old curves;
  - `pda::*`, instruction builders for legacy, v2, v3 and AMM v1/v2, quoting math, and `CPI_README.md`.
- **Usable with Anchor 0.31 — verified, but the version must be pinned:**
  - A fresh resolve with `default-features = false` pulled **anchor-lang 1.2.0 and anchor-spl 1.2.0** next to our 0.31.1, which caused many `E0308 mismatched types` errors.
  - Fix: `cargo update -p anchor-spl@1.2.0 --precise 0.31.1`. Then everything resolved to anchor 0.31.1 / solana-program 2.3.0 and `cargo build-sbf` (platform-tools v1.54) built.
  - The typed `pump_rust_client::pump::cpi::buy_v2(CpiContext::new_with_signer(..), amount, max_sol_cost, OptionBool(true))` call **executed successfully** on the fork with the vault PDA signing.
  - Note that the crate's generated `buy_v2` takes the 3rd arg `partial_fill`. The `CPI_README.md` sample shows only 2 args and is stale.
  - Pulling in `anchor-spl` with `metadata` also brings `mpl-token-metadata` (5.1.2-alpha.2 in the lock), which adds build weight.
  - Commit the `Cargo.lock`.

### npm

| package | latest | modified | web3.js | anchor |
|---|---|---|---|---|
| `@pump-fun/pump-sdk` | **2.0.0** | 2026-09-13 | `^1.98.2` (resolves 1.99.0) | `@coral-xyz/anchor ^0.31.1` |
| `@pump-fun/pump-swap-sdk` | **1.20.0** | 2026-09-10 | `^1.98.2` | `^0.31.1` |

`pump-sdk` depends on `pump-swap-sdk ^1.13.0` and `@pump-fun/agent-payments-sdk 1.0.7`. **Neither npm package knows v3 / AMM v2 yet** (0 matches in their IDLs).

Key `PumpSdk` functions:
- trading: `getBuyV2InstructionRaw`, `getSellV2InstructionRaw`, `buyV2Instructions`, `sellV2Instructions`, `getBuyInstructionRaw`, `getSellInstructionRaw`, `buyInstructions`, `sellInstructions`;
- creation: `createV2Instruction`, `createV2AndBuyV2Instructions`, `createV2AndBuyInstructions`;
- fee sharing: `createFeeSharingConfig`, `updateFeeShares`, `updateFeeSharesV2`, `distributeCreatorFees`, `distributeCreatorFeesV2`, `getMinimumDistributableFee`, `transferCreatorFeesToPumpV2`, `adminCtoInstruction`;
- volume accumulator: `initUserVolumeAccumulator`, `closeUserVolumeAccumulator`, `syncUserVolumeAccumulator`;
- decoding: `decodeBondingCurve`, `decodeGlobal`, `decodeFeeConfig`, `decodeSharingConfig`, event decoders.

Key `OnlinePumpSdk` functions: `fetchGlobal`, `fetchFeeConfig`, `fetchBondingCurve`, `fetchBuyState`, `fetchSellState`, `buildDistributeCreatorFeesInstructions`, `getCreatorVaultBalanceBothPrograms`.

Key `pump-swap-sdk` exports: `OnlinePumpAmmSdk.swapSolanaState`, `fetchPool`, `fetchGlobalConfigAccount`, `fetchFeeConfigAccount`; `PUMP_AMM_SDK.buyQuoteInput` / `buyBaseInput` / `sellBaseInput` / `sellQuoteInput`; `canonicalPumpPoolPda`.

**The npm SDKs cannot send v1 txs.** web3.js 1.x can only *read* v1 transactions (solana.com/upgrades/larger-transaction-sizes). Reading mainnet pump txs already needs `maxSupportedTransactionVersion: 1`: one of the 7 recent pump txs I sampled was v1, and `getTransaction` without that flag returns `-32015`.

---

## 6. Token-2022 coins and burning from the PDA

Sample: three live `create_v2` mints (`DEpk5F4A…pump`, `A25G75Jg…pump`, `7MK1KMam…pump`). Each is owned by Token-2022 with 6 decimals, and has:
- **mint authority null and freeze authority null;**
- **extensions: only `MetadataPointer` + `TokenMetadata`** (metadata update authority null).

They have no TransferFee, TransferHook, PermanentDelegate, NonTransferable, Pausable or DefaultAccountState, so **nothing blocks transfers or burns**. A `BurnChecked` from the owner reduced the mint supply as expected on the fork (999,857,627,726,837 → 999,448,294,901,916).

For the vault: call `token_2022::burn_checked` (or `token_interface::burn_checked`) with `authority = vault PDA` through `invoke_signed`. That is the same Token-2022 path, just with a PDA signer. [INFERENCE: the tested burn used a keypair owner.]

Token-2022 ATAs for these mints are 170 bytes (ImmutableOwner), rent ≈ 0.00207408 SOL. Legacy `create` coins use SPL Token, so always read `mint.owner` for the token program.

Do not assume future coins share this extension set. Check the mint's extensions in `register_copier` and reject TransferHook, PermanentDelegate, Pausable and TransferFee.

---

## 7. Recommendation: generic pass-through CPI with balance-delta checks

### 7.1 History of breaking account-list changes

- Apr 28: new buyback recipient account plus AMM `pool-v2` / remaining accounts (`BREAKING_FEE_RECIPIENT.md`).
- May 12: creator vault accounts (`PUMP_CREATOR_FEE_README.md`, `PUMP_SWAP_CREATOR_FEE_README.md`).
- Sep 1: `fee_config` / `fee_program` added (`FEE_PROGRAM_README.md`).
- Later: cashback remaining accounts, the v2 unified interface with 6 new accounts, the optional `partial_fill` arg, and now the **live-but-undocumented v3 / AMM v2 interfaces with different account sets**.

### 7.2 Comparison

| | Generic pass-through (tested) | Typed `declare_program!` / `pump_rust_client::cpi` (tested) |
|---|---|---|
| Shape | `ix(user_index/descriptor, data: Vec<u8>)` + `remaining_accounts`. Check `program_id ∈ {pump, pump_amm}`, check `(program, disc)` against a whitelist, check `remaining[user_idx] == vault`, then `invoke_signed` | A struct copying pump's exact account order; generated `cpi::buy_v2(...)` |
| Survives pump account / arg changes | **Yes, if the change is only accounts or trailing args.** The keeper (off-chain) updates; no program redeploy. New ix names (e.g. v3) need a whitelist entry, which can be a config account | **No.** Every change needs a new IDL, rebuild and redeploy. If copy-vault is ever frozen, trading breaks permanently |
| On-chain CU overhead (measured, buy_v2) | ≈16.8k CU (104,146 − 87,320) | ≈22.4k CU (109,689 − 87,325) |
| Type safety / audit clarity | Lower. Safety comes from invariants (balance deltas, whitelist, account-role checks) | Higher. Anchor checks the account order for you |
| Dependency risk | Only anchor-lang | pump-rust-client pulls anchor-spl metadata / mpl-token-metadata and needs anchor pinning (§5) |
| Program-side quote / slippage checks | Needed either way: read curve / pool state from the passed accounts | Same |

**Recommendation: use the generic pass-through.** It is the only option that tolerates pump's change rate without redeploys. Harden it with a **config-driven instruction-descriptor whitelist**, so new pump variants can be enabled by an admin or timelock without code changes. Each descriptor is:

```text
{ program, disc[8], side, user_idx, base_mint_idx, user_base_ata_idx, user_quote_idx?, curve_or_pool_idx, min_len }
```

Use `pump_rust_client` as a **dev / keeper dependency** for account derivation and quoting, not for the CPI itself.

### 7.3 Invariants the program must enforce (the vault PDA signs whatever we forward)

1. **Whitelist trade instructions only, keyed by (program, disc).**
   - pump: `buy_v2`, `sell_v2`, `buy_exact_quote_in_v2`, `buy_v3`, `sell_v3`, `buy_exact_quote_in_v3` (optionally the legacy `buy`, `sell`, `buy_exact_sol_in`).
   - pump_amm: `buy`, `sell`, `buy_exact_quote_in`, `buy_v2`, `sell_v2`, `buy_exact_quote_in_v2`.
   - **Never allow** `create_v2`, `extend_account`, `init/close_user_volume_accumulator`, `migrate`, `deposit`, `withdraw`, `create_pool` or other admin instructions. With the vault signing they would spend vault SOL or move vault assets.
2. **Vault position:** `remaining[user_idx] == vault`, and the vault appears **nowhere else**. Set `is_signer` only for the vault.
3. **Mint binding:** `remaining[base_mint_idx] == expected mint` (the copied mint for this trade). Also check the curve / pool account matches its PDA for that mint.
4. **Snapshot before, re-read after the CPI:**
   - vault lamports;
   - vault wSOL ATA amount;
   - vault base-mint ATA amount (decode the token account `amount` at offset 64).

   Then enforce:
   - **buy:** Δtokens ≥ min_out (computed on-chain from reserves and the slippage bps); Δ(lamports + wSOL) ≤ cap (spend + allowed rent);
   - **sell:** Δtokens ≤ requested; Δquote ≥ min_out.
5. **Defence in depth:** reject any additional writable token account in `remaining` whose `owner` field is the vault. This prevents touching basket positions in other mints.
6. **Do not rely on the trade instruction's own `max_sol_cost` / `min_out`** — the keeper sets those. The program's own delta checks are authoritative.

---

## 8. CU and tx-size budgets

### 8.1 Measured on the mainnet fork

Setup: Agave test-validator 4.2.1 with cloned mainnet programs. A 0.05-SOL trade, the vault PDA as user, a 400k CU limit, and v0 messages with no ALT and 1 signature.

| tx (wrapper `proxy` → target) | total CU | target program CU | wrapper overhead | tx bytes (limit 1232) | accounts |
|---|---|---|---|---|---|
| buy_v2, first (UVA init) | 109,162 | 92,186 | ~16.8k | **1,142** | 30 |
| buy_v2 (UVA exists) | 104,296 | 87,320 | ~16.8k | 1,142 | 30 |
| **typed** buy_v2 (pump-rust-client cpi) | 109,839 | 87,325 | ~22.4k | 1,129 | 30 |
| sell_v2 | 92,973 | 76,518 | ~16.3k | 1,109 | 29 |
| **buy_v3** | **63,351** | 51,651 | ~11.6k | **813** | 20 |
| **sell_v3** | **61,259** | 49,559 | ~11.6k | 812 | 20 |
| AMM buy_exact_quote_in (legacy, 26 accts) | 97,396 | 81,104 | ~16.1k | 1,078 | 28 |
| AMM buy_exact_quote_in_v2 (17 accts) | 62,069 | 50,566 | ~11.4k | 780 | 19 |
| AMM sell_v2 | 59,717 | 48,214 | ~11.4k | 780 | 19 |
| AMM sell (legacy) | 82,653 | 67,360 | ~15.1k | 1,011 | 26 |

Other measurements:
- Direct (no wrapper) mainnet simulations: buy_v2 87–92k CU (mayhem coin 91.9k), sell_v2 74–80k, buy_v3 50–53k, sell_v3 45–48k, AMM legacy buy 79.7k.
- Token-2022 ATA create ≈ 17–18.6k CU.
- Token-2022 `burn_checked` ≈ 1.6k CU.

### 8.2 Published numbers

- `docs/FAQ.md`: CU use varies with PDA bump seeds and logged amounts; it recommends a static limit of `100_000`.
- `pump-fun-skills` defaults: `BUY_SELL_DEFAULT_UNITS = 120_000`, `AMM_BUY_SELL_DEFAULT_UNITS = 200_000`, `CREATE_DEFAULT_UNITS = 270_000`.
- The Rust SDK examples use 400,000.

### 8.3 Budget for `copier_buy` / `copier_sell`

The full instruction adds work on top of the measured proxy: target-wallet balance verification (1–2 token-account reads), state writes, on-chain quote math, and wSOL wrap / sync for AMM (~3–5k). Plan for:
- **v3 / AMM v2:** about 75–90k, so set the limit to **~150k**;
- **v2 / AMM legacy:** about 110–130k, so set the limit to **~200k**.

Then simulate and set the limit to the simulated value plus ~10%. The bonding-curve completion buy runs extra code (FAQ).

### 8.4 Tx size and ALTs

- **v2 is tight.** A bare proxied buy_v2 is already 1,142 of 1,232 bytes. copy-vault's real instruction adds config, state, snapshot, target-wallet ATA and so on: roughly 4–6 extra accounts × 32 bytes plus data. That **will exceed 1,232 bytes**.
- **The fix is one of two:**
  - **v0 + ALT.** Put the static accounts in our own ALT and **freeze it** — programs, Global, FeeConfigs, event authorities, all 24 fee recipients and their wSOL ATAs, token / system / ATA programs, our config PDA. Optionally also reference pump's frozen ALT `7mFD2mUt…` (43 addresses; frozen, so safe to depend on). Per-coin accounts (curve, curve ATA, vault ATAs) can go in a per-copier ALT created at `register_copier`.
  - **Transaction v1.** Live on mainnet since 2026-09-15 (epoch 1035): up to **4,096 bytes and 64 accounts, no ALTs**. CU and loaded-data limits go in the message config and default to 0, so they must be set explicitly. The keeper needs `@solana/kit ≥ 8`, `@solana/web3.js ≥ 3.0.0-rc.3` or Rust `solana-*` 4.2.x. Jito leaders need jito-solana ≥ 4.2.2. Source: https://solana.com/upgrades/larger-transaction-sizes. [UNVERIFIED: I did not send a v1 tx through the wrapper.]
- **v3 / AMM v2 paths (~780–815 bytes) fit in v0 without an ALT,** with room for copy-vault's extra accounts.
- **CPI depth is fine:** wrapper → pump → Token / System / pump self-CPI for events is 3 levels, within the limit of 4. copy-vault's trade instruction must itself be top-level, not CPI'd by another program.

---

## 9. Open items and uncertainty

- **v3 / AMM v2 are live but undocumented** in public-docs and the npm SDKs. The only official source is pump-rust-client 0.2.0. Expect an announcement and possibly more changes, and track crate releases.
- [UNVERIFIED] The exact `buyback_basis_points` split formula.
- [UNVERIFIED] Behaviour when `user` is a data-carrying PDA. Expected to fail per System program rules; not tested.
- [UNVERIFIED] Sending v1 transactions through the wrapper.
- [INFERENCE] The burn test used a keypair owner. PDA-signed Token-2022 burns follow the same standard `invoke_signed` path.
- Mayhem coins worked with buy_v2 using a reserved fee recipient (mainnet sim). No extra accounts are needed in v2 or v3.
