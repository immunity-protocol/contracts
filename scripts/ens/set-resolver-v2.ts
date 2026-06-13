/**
 * Set the CCIP-Read resolver on the ENS **v2** name `immunity.eth` (Sepolia),
 * so `*.immunity.eth` resolves the on-chain reputation mirror via our gateway.
 *
 * Why a script (not the app): the ENS v2 testnet app (sepolia.app.ens.domains)
 * exposes Bio/Theme/Contact/Address but **no custom-resolver field** — there is
 * no way in the UI to point a name at a CCIP-Read resolver. So we do it directly
 * against the v2 registry, following the ENSv2 (Namechain) contract pattern.
 *
 * How the targets were found (ENSv2 has no published Sepolia address file yet):
 *   - The v2 name is minted as an ERC-1155 token to its owner. We located the
 *     mint to the deployer → the minting contract IS the v2 `.eth` registry
 *     (a PermissionedRegistry), and the token id is `immunity`'s canonical id.
 *   - PermissionedRegistry.setResolver(uint256 anyId, address resolver) requires
 *     ROLE_SET_RESOLVER on the token (the owner holds it); `anyId` accepts the
 *     labelhash / token id and is canonicalized via LibLabel.withVersion().
 *   - getResolver(string label) reads it back (permissionless view).
 *
 * Run:
 *   IMMUNITY_SEPOLIA_DEPLOYER_PK=0x… RESOLVER=0xad4216… \
 *     node --experimental-strip-types scripts/ens/set-resolver-v2.ts
 */
import { createWalletClient, createPublicClient, http, getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

const RPC = process.env.IMMUNITY_SEPOLIA_RPC ?? "https://ethereum-sepolia-rpc.publicnode.com";
const PK = process.env.IMMUNITY_SEPOLIA_DEPLOYER_PK as Hex | undefined;
if (!PK) throw new Error("set IMMUNITY_SEPOLIA_DEPLOYER_PK=0x…");

// ENSv2 .eth registry on Sepolia (the ERC-1155 that minted immunity.eth — see header).
const REGISTRY = getAddress(process.env.ENS_V2_ETH_REGISTRY ?? "0xdedb92913a25abe1f7bcdd85d8a344a43b398b67");
const LABEL = process.env.LABEL ?? "immunity";
// Canonical token id of `immunity` on that registry (version bits zeroed).
const TOKEN_ID = BigInt(
  process.env.TOKEN_ID ?? "0x8037610a0b17ef35ef5bea0f04a98440c4f497bcd569a5481709f5bf00000000",
);
// Our CCIP-Read resolver on Sepolia (ImmunityL1Resolver).
const RESOLVER = getAddress(process.env.RESOLVER ?? "0xad42167258579733c571c1d41cc7058caac0c9b7");

const abi = [
  { type: "function", name: "setResolver", stateMutability: "nonpayable", inputs: [{ name: "anyId", type: "uint256" }, { name: "resolver", type: "address" }], outputs: [] },
  { type: "function", name: "getResolver", stateMutability: "view", inputs: [{ name: "label", type: "string" }], outputs: [{ type: "address" }] },
] as const;

async function main() {
  const account = privateKeyToAccount(PK!);
  const transport = http(RPC);
  const pub = createPublicClient({ chain: sepolia, transport });
  const wallet = createWalletClient({ account, chain: sepolia, transport });

  console.log(`registry: ${REGISTRY}`);
  console.log(`name:     ${LABEL}.eth  (tokenId ${TOKEN_ID.toString(16).slice(0, 12)}…)`);
  console.log(`owner:    ${account.address}`);
  console.log(`resolver: ${RESOLVER}\n`);

  const before = (await pub.readContract({ address: REGISTRY, abi, functionName: "getResolver", args: [LABEL] })) as string;
  console.log(`resolver (before): ${before}`);

  const hash = await wallet.writeContract({ address: REGISTRY, abi, functionName: "setResolver", args: [TOKEN_ID, RESOLVER] });
  console.log(`setResolver tx: ${hash} …waiting`);
  await pub.waitForTransactionReceipt({ hash });

  const after = (await pub.readContract({ address: REGISTRY, abi, functionName: "getResolver", args: [LABEL] })) as string;
  console.log(`resolver (after):  ${after}`);
  console.log(after.toLowerCase() === RESOLVER.toLowerCase() ? "\n✅ resolver set on the v2 name" : "\n✗ resolver did not update");
}

main().catch((e) => {
  console.error(e.shortMessage ?? e.message ?? e);
  process.exitCode = 1;
});
