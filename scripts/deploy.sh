#!/usr/bin/env bash
# Builds and deploys (or upgrades) the copier program on a cluster. Runs in WSL/Linux/macOS.
#
#   CLUSTER=devnet       ADMIN_KEYPAIR=~/keys/copier-admin.json bash scripts/deploy.sh          (build + plan only)
#   CLUSTER=mainnet-beta ADMIN_KEYPAIR=~/keys/copier-admin.json RPC_URL=https://… bash scripts/deploy.sh --yes
#   CLUSTER=localnet bash scripts/deploy.sh --skip-build          (what `pnpm localnet deploy` runs)
#
# Flags: --yes         required to send anything to devnet / mainnet-beta (without it the plan is printed, exit 2;
#                      the local build still runs). Localnet deploys without it.
#        --skip-build  deploy the existing target/deploy/copy_vault.so instead of running `anchor build`
#        --final       after deploying, print the upgrade-authority / admin handoff commands (nothing is changed)
#
# Env: CLUSTER (localnet | devnet | mainnet-beta, default devnet), RPC_URL (default: the cluster's public RPC, or
#      http://127.0.0.1:$RPC_PORT on localnet), ADMIN_KEYPAIR (the payer AND upgrade authority; default
#      <state dir>/admin.json, where the state dir is KEYS_DIR or .localnet / .devnet / .mainnet; it is never created
#      here outside localnet), PRIORITY_MICROLAMPORTS (compute-unit price for the ~1,100 buffer writes; default
#      100000 on real clusters, 0 on localnet).
#
# The upgrade authority must also be the config admin: `initialize_config` (pnpm setup:cluster) only accepts the
# program's upgrade authority. The program id comes from .secrets/copy_vault-keypair.json (never printed).
set -euo pipefail
# Non-login shells (e.g. `wsl bash …`) don't source the Solana installer's PATH entry.
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$HOME/.avm/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
EXPECTED_PROGRAM_ID=9R8g8JtEqRAh5yZ4aXbf1mWcfgLq9kAo6fmx93MSK9k7

YES="" SKIP_BUILD="" FINAL=""
for arg in "$@"; do
  case "$arg" in
    --yes) YES=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    --final) FINAL=1 ;;
    *) echo "unknown argument: $arg (usage: deploy.sh [--yes] [--skip-build] [--final])" >&2; exit 2 ;;
  esac
done

CLUSTER="${CLUSTER:-devnet}"
case "$CLUSTER" in
  localnet) DEFAULT_RPC="http://127.0.0.1:${RPC_PORT:-8899}"; DEFAULT_DIR=.localnet; DEFAULT_PRIORITY=0 ;;
  devnet) DEFAULT_RPC="https://api.devnet.solana.com"; DEFAULT_DIR=.devnet; DEFAULT_PRIORITY=100000 ;;
  mainnet-beta) DEFAULT_RPC="https://api.mainnet-beta.solana.com"; DEFAULT_DIR=.mainnet; DEFAULT_PRIORITY=100000 ;;
  *) echo "CLUSTER must be localnet, devnet or mainnet-beta (got $CLUSTER)" >&2; exit 2 ;;
esac
RPC="${RPC_URL:-$DEFAULT_RPC}"
STATE_DIR="${KEYS_DIR:-$DEFAULT_DIR}"
ADMIN="${ADMIN_KEYPAIR:-$STATE_DIR/admin.json}"
ADMIN="${ADMIN/#\~/$HOME}"
PRIORITY="${PRIORITY_MICROLAMPORTS:-$DEFAULT_PRIORITY}"
PROGRAM_KEYPAIR=.secrets/copy_vault-keypair.json
SO=target/deploy/copy_vault.so

die() { echo "✗ $*" >&2; exit 1; }

[ -f "$PROGRAM_KEYPAIR" ] || die "$PROGRAM_KEYPAIR missing (the program id keypair)"
PROGRAM_ID="$(solana-keygen pubkey "$PROGRAM_KEYPAIR")"
[ "$PROGRAM_ID" = "$EXPECTED_PROGRAM_ID" ] || die "$PROGRAM_KEYPAIR is $PROGRAM_ID, expected $EXPECTED_PROGRAM_ID"
grep -q "declare_id!(\"$PROGRAM_ID\")" programs/copy-vault/src/lib.rs || die "programs/copy-vault/src/lib.rs does not declare $PROGRAM_ID"

if [ ! -f "$ADMIN" ]; then
  [ "$CLUSTER" = localnet ] || die "ADMIN_KEYPAIR $ADMIN not found. Create it (solana-keygen new -o <path>), fund it, and pass its path"
  mkdir -p "$(dirname "$ADMIN")"
  solana-keygen new --no-bip39-passphrase --silent --outfile "$ADMIN" >/dev/null
fi
ADMIN_PUBKEY="$(solana-keygen pubkey "$ADMIN")"

if [ -z "$SKIP_BUILD" ]; then
  # anchor build signs the program id from target/deploy/copy_vault-keypair.json: make it the real one.
  mkdir -p target/deploy
  cp "$PROGRAM_KEYPAIR" target/deploy/copy_vault-keypair.json
  chmod 600 target/deploy/copy_vault-keypair.json
  echo "anchor build…" >&2
  anchor build
fi
[ -f "$SO" ] || die "$SO not built (run without --skip-build)"
SIZE="$(stat -c %s "$SO")"
SHA="$(sha256sum "$SO" | cut -d' ' -f1)"
# ProgramData = 45-byte header + the ELF; the deploy also rents a same-size buffer, refunded at the end.
RENT_SOL="$(solana rent $((SIZE + 45)) | awk '{print $3}')"

if [ "$CLUSTER" = localnet ]; then
  solana airdrop -u "$RPC" 20 "$ADMIN_PUBKEY" >/dev/null 2>&1 || true
fi
BALANCE_LAMPORTS="$(solana balance -u "$RPC" "$ADMIN_PUBKEY" --lamports | awk '{print $1}')"
if SHOW="$(solana program show -u "$RPC" "$PROGRAM_ID" 2>/dev/null)"; then
  CURRENT_AUTHORITY="$(awk '/^Authority:/ {print $2}' <<<"$SHOW")"
  MODE="upgrade (current authority $CURRENT_AUTHORITY)"
  [ "$CURRENT_AUTHORITY" = "$ADMIN_PUBKEY" ] || die "program $PROGRAM_ID exists with upgrade authority $CURRENT_AUTHORITY, not $ADMIN_PUBKEY"
else
  MODE="initial deploy"
fi
NEEDED_LAMPORTS="$(awk -v r="$RENT_SOL" 'BEGIN { printf "%d", (2 * r + 0.1) * 1e9 }')"

cat <<EOF
cluster     $CLUSTER ($RPC)
program     $PROGRAM_ID — $MODE
binary      $SO ($SIZE bytes, sha256 $SHA)
authority   $ADMIN_PUBKEY ($ADMIN) — payer and upgrade authority
balance     $(awk -v l="$BALANCE_LAMPORTS" 'BEGIN { printf "%.4f", l / 1e9 }') SOL; needs ≈ $(awk -v l="$NEEDED_LAMPORTS" 'BEGIN { printf "%.4f", l / 1e9 }') SOL at peak (program rent $RENT_SOL SOL + same-size buffer, refunded, + fees)
priority    $PRIORITY µlamports/CU
EOF
FUNDED=1
[ "$BALANCE_LAMPORTS" -ge "$NEEDED_LAMPORTS" ] || { FUNDED=""; echo "✗ fund $ADMIN_PUBKEY first" >&2; }
if [ "$CLUSTER" != localnet ] && [ -z "$YES" ]; then
  echo "dry run: nothing was sent. Re-run with --yes to deploy to $CLUSTER" >&2
  exit 2
fi
[ -n "$FUNDED" ] || exit 1

# Extra signing rounds so the buffer writes land on a congested cluster; a failed run prints the buffer's
# recovery seed phrase so the upload can resume (solana program deploy --buffer …) instead of paying twice.
solana program deploy --url "$RPC" --keypair "$ADMIN" --upgrade-authority "$ADMIN" \
  --with-compute-unit-price "$PRIORITY" --max-sign-attempts 50 \
  --program-id "$PROGRAM_KEYPAIR" "$SO"

# Verify the on-chain bytes are this build (ProgramData may be zero-padded past the ELF).
DUMP="$(mktemp)"
trap 'rm -f "$DUMP"' EXIT
solana program dump -u "$RPC" "$PROGRAM_ID" "$DUMP" >/dev/null
ONCHAIN_SHA="$(head -c "$SIZE" "$DUMP" | sha256sum | cut -d' ' -f1)"
[ "$ONCHAIN_SHA" = "$SHA" ] || die "on-chain program data ($ONCHAIN_SHA) differs from $SO ($SHA)"
echo
echo "deployed $PROGRAM_ID on $CLUSTER"
echo "  data sha256 $ONCHAIN_SHA (matches $SO)"
solana program show -u "$RPC" "$PROGRAM_ID" | sed 's/^/  /'
echo
echo "next: CLUSTER=$CLUSTER ADMIN_KEYPAIR=$ADMIN KEEPER_PUBKEY=<keeper> RPC_URL=$RPC pnpm setup:cluster"

if [ -n "$FINAL" ]; then
  cat <<EOF

Handoff (not executed):
  1. Config admin → multisig: propose_admin(<multisig vault>) signed by $ADMIN_PUBKEY, then accept_admin signed by
     the multisig (two steps; the old admin keeps control until the multisig accepts).
  2. Upgrade authority → the same multisig:
       solana program set-upgrade-authority $PROGRAM_ID -u $RPC --keypair $ADMIN \\
         --new-upgrade-authority <multisig vault> --skip-new-upgrade-authority-signer-check
     or make the program immutable for good: solana program set-upgrade-authority $PROGRAM_ID --final
EOF
fi
