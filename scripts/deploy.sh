#!/bin/bash
set -euo pipefail

#
# deploy.sh — orchestrates a full ImmunityRegistry deploy on Base Sepolia.
#
# Usage:
#   ./scripts/deploy.sh                              # deploys MockUSDC + Registry (testnet default)
#   ./scripts/deploy.sh --usdc 0xCANONICAL          # uses an existing USDC token
#   ./scripts/deploy.sh --challenge-manager 0xADDR  # set the challenge-manager (default: zero, set later)
#
# Requires keystore secrets:
#   npx hardhat keystore set IMMUNITY_BASE_SEPOLIA_RPC
#   npx hardhat keystore set IMMUNITY_DEPLOYER_PK
#
# Fund the deployer on Base Sepolia: https://www.alchemy.com/faucets/base-sepolia
# Canonical Base Sepolia USDC: 0x036CbD53842c5426634e7929541eC2318f3dCF7e
#

NETWORK="baseSepolia"
CHAIN_ID="84532"
DEPLOY_DIR="ignition/deployments/chain-${CHAIN_ID}"
PARAMS_FILE="ignition/parameters/baseSepolia.json"
OUTPUT_FILE=".deploy.json"

USDC_ADDRESS=""
CHALLENGE_MANAGER="0x0000000000000000000000000000000000000000"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --usdc) USDC_ADDRESS="$2"; shift 2 ;;
    --challenge-manager) CHALLENGE_MANAGER="$2"; shift 2 ;;
    -h|--help) sed -n '3,20p' "$0"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

echo "=== ImmunityRegistry Deployment (network: ${NETWORK}, chainId: ${CHAIN_ID}) ==="
echo ""

echo "Step 1: cleaning previous deployment state..."
rm -rf "${DEPLOY_DIR}"
echo "  Done."
echo ""

if [[ -z "${USDC_ADDRESS}" ]]; then
  echo "Step 2: no --usdc flag provided; deploying MockUSDC..."
  npx hardhat ignition deploy ignition/modules/MockUSDC.ts --network "${NETWORK}"
  USDC_ADDRESS=$(jq -r '."MockUSDC#MockUSDC"' "${DEPLOY_DIR}/deployed_addresses.json")
  if [[ -z "${USDC_ADDRESS}" || "${USDC_ADDRESS}" == "null" ]]; then
    echo "ERROR: failed to read MockUSDC address" >&2; exit 1
  fi
  echo "  MockUSDC deployed at: ${USDC_ADDRESS}"
else
  echo "Step 2: using provided USDC address: ${USDC_ADDRESS}"
fi
echo ""

echo "Step 3: writing ${PARAMS_FILE} (usdc + challengeManager)..."
jq --arg usdc "${USDC_ADDRESS}" --arg cm "${CHALLENGE_MANAGER}" \
  '.ImmunityRegistry.usdc = $usdc | .ImmunityRegistry.challengeManager = $cm' \
  "${PARAMS_FILE}" > "${PARAMS_FILE}.tmp" && mv "${PARAMS_FILE}.tmp" "${PARAMS_FILE}"
echo "  Done."
echo ""

echo "Step 4: deploying ImmunityRegistry..."
npx hardhat ignition deploy ignition/modules/ImmunityRegistry.ts --network "${NETWORK}" \
  --parameters "${PARAMS_FILE}"
echo ""

REGISTRY_ADDRESS=$(jq -r '."ImmunityRegistry#ImmunityRegistry"' "${DEPLOY_DIR}/deployed_addresses.json")
if [[ -z "${REGISTRY_ADDRESS}" || "${REGISTRY_ADDRESS}" == "null" ]]; then
  echo "ERROR: failed to read Registry address" >&2; exit 1
fi
echo "  ImmunityRegistry deployed at: ${REGISTRY_ADDRESS}"
echo ""

echo "Step 5: writing ${OUTPUT_FILE} + network.json..."
cat > "${OUTPUT_FILE}" <<EOF
{
  "network": "${NETWORK}",
  "chainId": ${CHAIN_ID},
  "registry": "${REGISTRY_ADDRESS}",
  "usdc": "${USDC_ADDRESS}",
  "challengeManager": "${CHALLENGE_MANAGER}"
}
EOF

cat > "network.json" <<EOF
{
  "name": "base-sepolia",
  "chainId": ${CHAIN_ID},
  "rpcUrl": "https://sepolia.base.org",
  "registryAddress": "${REGISTRY_ADDRESS}",
  "usdcAddress": "${USDC_ADDRESS}",
  "blockExplorerUrl": "https://sepolia.basescan.org",
  "storageProvider": "lighthouse",
  "computeProvider": "chainlink-cre"
}
EOF
echo "  Done."
echo ""

echo "=== Deployment Complete ==="
echo "Registry: ${REGISTRY_ADDRESS}"
echo "USDC:     ${USDC_ADDRESS}"
echo "Explorer: https://sepolia.basescan.org/address/${REGISTRY_ADDRESS}"
echo ""
echo "Note: challengeManager is ${CHALLENGE_MANAGER}. If zero, set it later via"
echo "      setDependencies once the ChallengeManager is deployed."
