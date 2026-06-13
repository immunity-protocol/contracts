/**
 * Deploy ImmunityL1Resolver to a network (default: Ethereum Sepolia).
 *
 * The L1 resolver is the EIP-3668 CCIP-Read + ENSIP-10 wildcard resolver ENS
 * apps query. It pins:
 *   - gatewayUrls   the CCIP gateway endpoint(s) (template {sender}/{data} form)
 *   - trustedSigner the gateway's signer ADDRESS (the key is a gateway secret)
 *
 * Both are owner-updatable post-deploy (setGatewayUrls / setTrustedSigner), so
 * the gateway URL can be set to a placeholder now and repointed once the
 * gateway is live.
 *
 * Run:
 *   IMMUNITY_SEPOLIA_DEPLOYER_PK=0x… \
 *   TRUSTED_SIGNER=0x… \
 *   GATEWAY_URL=https://immunity-ccip-gateway.fly.dev/{sender}/{data}.json \
 *   node --experimental-strip-types scripts/ens/deploy-l1-resolver.ts
 */
import { readFileSync } from "node:fs";
import {
  createWalletClient,
  createPublicClient,
  http,
  getAddress,
  formatEther,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

const RPC = process.env.IMMUNITY_SEPOLIA_RPC ?? "https://ethereum-sepolia-rpc.publicnode.com";
const PK = process.env.IMMUNITY_SEPOLIA_DEPLOYER_PK as Hex | undefined;
if (!PK) throw new Error("set IMMUNITY_SEPOLIA_DEPLOYER_PK=0x…");

const TRUSTED_SIGNER = getAddress(
  process.env.TRUSTED_SIGNER ?? "0x0000000000000000000000000000000000000000",
);
if (TRUSTED_SIGNER === "0x0000000000000000000000000000000000000000") {
  throw new Error("set TRUSTED_SIGNER=0x… (the gateway's signer address)");
}
const GATEWAY_URL =
  process.env.GATEWAY_URL ?? "https://immunity-ccip-gateway.fly.dev/{sender}/{data}.json";

const ARTIFACT = JSON.parse(
  readFileSync(
    new URL(
      "../../artifacts/contracts/ImmunityL1Resolver.sol/ImmunityL1Resolver.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

async function main() {
  const account = privateKeyToAccount(PK!);
  const transport = http(RPC);
  const pub = createPublicClient({ chain: sepolia, transport });
  const wallet = createWalletClient({ account, chain: sepolia, transport });

  const bal = await pub.getBalance({ address: account.address });
  console.log(`deployer:       ${account.address}`);
  console.log(`balance:        ${formatEther(bal)} ETH`);
  console.log(`gatewayUrl:     ${GATEWAY_URL}`);
  console.log(`trustedSigner:  ${TRUSTED_SIGNER}\n`);
  if (bal === 0n) throw new Error("deployer has no Sepolia ETH — fund it first");

  const hash = await wallet.deployContract({
    abi: ARTIFACT.abi,
    bytecode: ARTIFACT.bytecode,
    args: [[GATEWAY_URL], TRUSTED_SIGNER],
  });
  console.log(`deploy tx: ${hash}`);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  console.log(`\n✅ ImmunityL1Resolver deployed → ${receipt.contractAddress}`);
  console.log(`   block ${receipt.blockNumber}, gas used ${receipt.gasUsed}`);
}

main().catch((e) => {
  console.error(e.shortMessage ?? e.message ?? e);
  process.exitCode = 1;
});
