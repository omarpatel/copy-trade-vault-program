#!/usr/bin/env bash
# Local validator for copy-vault: mainnet pump.fun, PumpSwap, pump fees and the mayhem program (plus every
# config / fee-recipient account their create_v2, buy/sell, fee-sharing and migrate paths read) cloned
# from mainnet, and target/deploy/copy_vault.so preloaded as an upgradeable program whose upgrade authority is
# .localnet/admin.json (the admin setup.ts initializes the config with). Run inside WSL/Linux/macOS
# (from Windows: `pnpm localnet`, which runs this through WSL).
#
#   bash scripts/localnet.sh           resume the existing ledger (a missing ledger starts fresh)
#   bash scripts/localnet.sh --reset   fresh ledger: new genesis, freshly cloned mainnet programs and
#                                      accounts, freshly built copy_vault.so
#
# Env: LEDGER (default ~/.copier-ledger; keep it off /mnt/c, the 9P mount is far too slow for a ledger),
#      UPGRADE_AUTHORITY (default .localnet/admin.json), CLONE_URL (mainnet RPC the clones are read from,
#      default https://api.mainnet-beta.solana.com), LEDGER_LIMIT (shreds kept, default 1000000 ≈ hours of
#      history so a restarted indexer can backfill), RPC_PORT (default 8899; websocket = RPC_PORT + 1),
#      FAUCET_PORT (default 10100), GOSSIP_PORT (default 10101), DYNAMIC_PORT_RANGE (default 10110-10199).
#      The non-default faucet/gossip/dynamic ports keep this validator clear of other solana-test-validators
#      on the machine (their defaults are 9900 / 8000 / 8000-10000). Give each concurrent validator its own
#      LEDGER and ports. PRELOAD_PROGRAM=0 starts without the copier program at genesis (to exercise a real
#      `scripts/deploy.sh` deploy, as on devnet/mainnet).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# `wsl bash scripts/localnet.sh` runs a non-login shell that may not have the Solana PATH yet.
if ! command -v solana-test-validator >/dev/null 2>&1; then
  export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
fi
LEDGER="${LEDGER:-$HOME/.copier-ledger}"
ADMIN="${UPGRADE_AUTHORITY:-$ROOT/.localnet/admin.json}"
CLONE_URL="${CLONE_URL:-https://api.mainnet-beta.solana.com}"
PROGRAM_SO="$ROOT/target/deploy/copy_vault.so"
# Genesis preloads the program at the id the program declares, so no program keypair is needed locally.
PROGRAM_ID="$(sed -n 's/^declare_id!("\([1-9A-HJ-NP-Za-km-z]*\)");$/\1/p' "$ROOT/programs/copy-vault/src/lib.rs")"
[ -n "$PROGRAM_ID" ] || { echo "declare_id! not found in programs/copy-vault/src/lib.rs" >&2; exit 1; }

RESET=""
for arg in "$@"; do
  case "$arg" in
    --reset) RESET=1 ;;
    *) echo "unknown argument: $arg (usage: localnet.sh [--reset])" >&2; exit 2 ;;
  esac
done
# Genesis options (preloaded programs, clones) only apply when the ledger is created.
[ -f "$LEDGER/genesis.bin" ] || RESET=1
# Resuming after an unclean stop (WSL restart, kill): the validator restarts from its newest snapshot, but its saved
# vote tower can hold votes past that snapshot, which locks it out of voting ("Couldn't vote on heaviest fork:
# LockedOut") so no slot ever confirms again. A single-node test chain has nobody to equivocate against: drop it.
[ -z "$RESET" ] && rm -f "$LEDGER"/tower-*.bin

if [ ! -f "$ADMIN" ]; then
  mkdir -p "$(dirname "$ADMIN")"
  solana-keygen new --no-bip39-passphrase --silent --outfile "$ADMIN" >/dev/null
fi

PROGRAM_ARGS=()
if [ "${PRELOAD_PROGRAM:-1}" = 0 ]; then
  [ -z "$RESET" ] || echo "PRELOAD_PROGRAM=0: no copier program at genesis (deploy it: pnpm localnet deploy)" >&2
elif [ -f "$PROGRAM_SO" ]; then
  PROGRAM_ARGS=(--upgradeable-program "$PROGRAM_ID" "$PROGRAM_SO" "$ADMIN")
elif [ -n "$RESET" ]; then
  echo "warning: $PROGRAM_SO not built yet: starting with the pump programs only (anchor build, then pnpm localnet deploy)" >&2
fi

CLONE_ARGS=()
if [ -n "$RESET" ]; then
  PUMP=6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P
  PUMP_AMM=pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA
  PUMP_FEES=pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ
  MAYHEM=MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e
  TOKEN=TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA
  ATA=ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL
  WSOL=So11111111111111111111111111111111111111112
  PUMP_GLOBAL=4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf
  AMM_GLOBAL_CONFIG=ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw
  for p in "$PUMP" "$PUMP_AMM" "$PUMP_FEES" "$MAYHEM"; do
    CLONE_ARGS+=(--clone-upgradeable-program "$p")
  done

  pda() { # <program> <seed spec>...: PDA address (solana CLI seed syntax: string:…, pubkey:…, hex:…)
    solana find-program-derived-address "$@" | cut -d' ' -f1
  }
  wsol_ata() { pda "$ATA" "pubkey:$1" "pubkey:$TOKEN" "pubkey:$WSOL"; }

  # Static config PDAs: pump Global + global volume accumulator, both fee configs, the fee program's
  # globals, PumpSwap GlobalConfig + volume accumulator, the mayhem program's params and SOL vault
  # (create_v2 passes them even for non-mayhem coins).
  STATIC=(
    "$PUMP_GLOBAL" "$AMM_GLOBAL_CONFIG"
    "$(pda "$PUMP" string:global_volume_accumulator)"
    "$(pda "$PUMP_AMM" string:global_volume_accumulator)"
    "$(pda "$PUMP_FEES" string:fee_config "pubkey:$PUMP")"
    "$(pda "$PUMP_FEES" string:fee_config "pubkey:$PUMP_AMM")"
    "$(pda "$PUMP_FEES" string:global)"
    "$(pda "$PUMP_FEES" string:fee-program-global)"
    "$(pda "$MAYHEM" string:global-params)"
    "$(pda "$MAYHEM" string:sol-vault)"
    "$WSOL"
  )

  # Every wallet Global / GlobalConfig name (pump.fun rotates them, so they are read live): fee,
  # reserved (mayhem), buyback and PumpSwap protocol fee recipients, the withdraw authority and the
  # whitelist PDAs. They must exist funded (a system transfer can't leave an account below rent
  # exemption) and PumpSwap / v2 trades pay into their wSOL token accounts.
  echo "reading pump.fun's fee recipients from $CLONE_URL" >&2
  read_pubkeys() { # <account> <offset> <count>...: base58 of `count` pubkeys at each offset
    local account="$1"; shift
    solana account -u "$CLONE_URL" "$account" --output json | python3 -c '
import base64, json, sys
data = base64.b64decode(json.load(sys.stdin)["account"]["data"][0])
alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
def b58(raw):
    n = int.from_bytes(raw, "big"); out = ""
    while n: n, r = divmod(n, 58); out = alphabet[r] + out
    return "1" * (len(raw) - len(raw.lstrip(b"\0"))) + out
args = list(map(int, sys.argv[1:]))
seen = set()
for off, count in zip(args[::2], args[1::2]):
    for i in range(count):
        raw = data[off + 32 * i: off + 32 * i + 32]
        if raw != bytes(32) and raw not in seen:
            seen.add(raw); print(b58(raw))' "$@"
  }
  # pump Global: fee_recipient@41, withdraw_authority@113, fee_recipients[7]@162, whitelist_pda@451,
  # reserved_fee_recipient@483, reserved_fee_recipients[7]@516, buyback_fee_recipients[8]@741.
  mapfile -t PUMP_WALLETS < <(read_pubkeys "$PUMP_GLOBAL" 41 1 113 1 162 7 451 1 483 1 516 7 741 8)
  # GlobalConfig: protocol_fee_recipients[8]@57, whitelist_pda@353, reserved_fee_recipient@385,
  # reserved_fee_recipients[7]@418, buyback_fee_recipients[8]@643.
  mapfile -t AMM_WALLETS < <(read_pubkeys "$AMM_GLOBAL_CONFIG" 57 8 353 1 385 1 418 7 643 8)
  if [ "${#PUMP_WALLETS[@]}" -lt 10 ] || [ "${#AMM_WALLETS[@]}" -lt 10 ]; then
    echo "could not read pump.fun's Global / GlobalConfig from $CLONE_URL" >&2
    exit 1
  fi
  declare -A SEEN=()
  for a in "${STATIC[@]}" "${PUMP_WALLETS[@]}" "${AMM_WALLETS[@]}"; do SEEN[$a]=1; done
  for a in "${PUMP_WALLETS[@]}" "${AMM_WALLETS[@]}"; do SEEN[$(wsol_ata "$a")]=1; done
  for a in "${!SEEN[@]}"; do CLONE_ARGS+=(--maybe-clone "$a"); done
  # Mainnet's feature set, not the test validator's "everything on": otherwise e.g. SIMD-0500 (no SBPF v0-v2
  # deployments) is active locally while mainnet still accepts the v0 programs anchor builds, and
  # `pnpm localnet deploy` would fail on localnet for a program mainnet accepts.
  CLONE_ARGS+=(--clone-feature-set --url "$CLONE_URL")
  echo "cloning pump, pump_amm, pump_fees, mayhem, ${#SEEN[@]} accounts and the feature set from mainnet" >&2
fi

# Not `exec`: when the validator dies (e.g. a port is taken) the reason is in its ledger log, not on stderr.
status=0
solana-test-validator \
  ${RESET:+--reset} \
  --ledger "$LEDGER" \
  --limit-ledger-size "${LEDGER_LIMIT:-1000000}" \
  ${PROGRAM_ARGS[@]+"${PROGRAM_ARGS[@]}"} \
  --rpc-port "${RPC_PORT:-8899}" \
  --faucet-port "${FAUCET_PORT:-10100}" \
  --gossip-port "${GOSSIP_PORT:-10101}" \
  --dynamic-port-range "${DYNAMIC_PORT_RANGE:-10110-10199}" \
  ${CLONE_ARGS[@]+"${CLONE_ARGS[@]}"} \
  --quiet || status=$?
# 130 / 143: stopped by SIGINT / SIGTERM (pnpm stop:localnet).
if [ "$status" -ne 0 ] && [ "$status" -ne 130 ] && [ "$status" -ne 143 ]; then
  echo "solana-test-validator exited with $status; end of $LEDGER/validator.log:" >&2
  grep -E "panicked|Error|error" "$LEDGER/validator.log" | tail -n 5 >&2 || tail -n 20 "$LEDGER/validator.log" >&2
fi
exit "$status"
