#!/usr/bin/env bash
# Refreshes tests/program/fixtures from mainnet: the pump.fun, PumpSwap and pump fee programs,
# the mayhem program pump's create_v2 references, SPL Token (p-token on mainnet, stricter than
# litesvm's built-in spl-token), Token-2022 and the associated token account program, plus every
# config account their create / trade / fee-sharing / migrate instructions read. The litesvm suite
# loads all of it, so copy-vault is exercised against the programs live on mainnet today.
#
#   bash tests/program/dump-fixtures.sh              # public mainnet RPC
#   RPC_URL=<mainnet rpc> bash tests/program/dump-fixtures.sh
set -euo pipefail
cd "$(dirname "$0")"
RPC_URL="${RPC_URL:-https://api.mainnet-beta.solana.com}"
OUT=fixtures
mkdir -p "$OUT/accounts"

declare -A PROGRAMS=(
  [pump]=6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P
  [pump_amm]=pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA
  [pump_fees]=pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ
  [mayhem]=MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e
  [spl_token]=TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA
  [spl_token_2022]=TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
  [spl_associated_token_account]=ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL
)
for name in "${!PROGRAMS[@]}"; do
  solana program dump -u "$RPC_URL" "${PROGRAMS[$name]}" "$OUT/$name.so" >/dev/null
  # ProgramData is zero-padded up to its allocated length; keep only the ELF (program headers
  # and the section header table bound it).
  python3 - "$OUT/$name.so" <<'PY'
import struct, sys
p = sys.argv[1]
data = open(p, "rb").read()
assert data[:4] == b"\x7fELF", p
e_phoff, = struct.unpack_from("<Q", data, 0x20)
e_shoff, = struct.unpack_from("<Q", data, 0x28)
e_phentsize, e_phnum = struct.unpack_from("<HH", data, 0x36)
e_shentsize, e_shnum = struct.unpack_from("<HH", data, 0x3A)
end = e_shoff + e_shentsize * e_shnum
for i in range(e_phnum):
    base = e_phoff + i * e_phentsize
    p_offset, = struct.unpack_from("<Q", data, base + 8)
    p_filesz, = struct.unpack_from("<Q", data, base + 32)
    end = max(end, p_offset + p_filesz)
open(p, "wb").write(data[:end])
PY
  echo "program $name $(stat -c %s "$OUT/$name.so") bytes"
done

# Config accounts, stored as the JSON `solana account --output json` prints (pubkey, lamports,
# base64 data, owner). The harness loads every file in fixtures/accounts.
ACCOUNTS=(
  4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf # pump Global ["global"]
  Hq2wp8uJ9jCPsYgNHex8RtqdvMPfVGoYwjvF1ATiwn2Y # pump global_volume_accumulator
  8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt # pump_fees FeeConfig ["fee_config", pump]
  5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx # pump_fees FeeConfig ["fee_config", pump_amm]
  ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw # pump_amm GlobalConfig ["global_config"]
  C2aFPdENg4A2HQsmrd5rTw5TaYBX5Ku887cWjbFKtZpw # pump_amm global_volume_accumulator
  So11111111111111111111111111111111111111112  # wSOL mint
  39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg # pump Global.withdraw_authority (paid by migrate)
  # wSOL ATAs of the 8 buyback fee recipients (Global / GlobalConfig.buyback_fee_recipients):
  # PumpSwap v2 trades pay the buyback slice into them and never create them.
  HjQjngTDqoHE6aaGhUqfz9aQ7WZcBRjy5xB8PScLSr8i GAFuhgcd328SkkBYHpfadzmef9hTGAFRCi9QoCnsZQug
  AktftA98kSWAxn6kVSoqBXBELUArjKu2H9WmKB48ULFY 6rVkF4HSgy1jrnC3HogfRgPHrq4CtLg5f11URpsC4i9D
  GYH1Gae1wJytMSvMvw8JVcv7nuAbxi8i9erNVbERnzXd CA7v8gHfbquYXyDnDx6QxWW8hmL1H7X6Y2RYDrGLnuck
  CASRL2zkwDnppxEFQ4LgdwgR9pdz5Q8R8nEMKVZ9QoLp qkYdTGRPHbWTWuBMz45bCiU6a23axRqf6sBHm9295WY
  # wSOL ATAs of the 8 PumpSwap protocol fee recipients (GlobalConfig.protocol_fee_recipients).
  94qWNrtmfn42h3ZjUZwWvK1MEo9uVmmrBPd2hpNjYDjb 7GFUN3bWzJMKMRZ34JLsvcqdssDbXnp589SiE33KVwcC
  X5QPJcpph4mBAJDzc4hRziFftSbcygV59kRb2Fu6Je1 Bvtgim23rfocUzxVX9j9QFxTbBnH8JZxnaGLCEkXvjKS
  FGptqdxjahafaCzpZ1T6EDtCzYMv7Dyn5MgBLyB3VUFW 7xQYoUjUJF1Kg6WVczoTAkaNhn5syQYcbvjmFrhjWpx
  BWXT6RUhit9FfJQM3pBmqeFLPYmuxgmyhMGC5sGr8RbA DWpvfqzGWuVy9jVSKSShdM2733nrEsnnhsUStYbkj6Nn
)
# Mayhem program config create_v2 passes (["global-params"], ["sol-vault"] under mayhem).
MAYHEM=MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e
ACCOUNTS+=(
  "$(solana find-program-derived-address "$MAYHEM" string:global-params | awk '{print $1}')"
  "$(solana find-program-derived-address "$MAYHEM" string:sol-vault | awk '{print $1}')"
)
for key in "${ACCOUNTS[@]}"; do
  if solana account -u "$RPC_URL" "$key" --output json > "$OUT/accounts/$key.json" 2>/dev/null; then
    echo "account $key"
  else
    rm -f "$OUT/accounts/$key.json"
    echo "account $key (absent on mainnet, skipped)"
  fi
done
