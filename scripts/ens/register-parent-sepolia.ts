/**
 * Register the parent name `immunity.eth` on Sepolia and set its resolver to
 * ImmunityL1Resolver, so `*.immunity.eth` resolves via CCIP-Read in any ENS app
 * (Work Package §C).
 *
 * `immunity.eth` is unregistered on Sepolia and its namehash already matches the
 * live Base Sepolia PublisherRegistrar's `parentNode`, so registering it (vs a
 * different test name) needs NO registrar parentNode change.
 *
 * Commit/reveal flow (ENS ETHRegistrarController):
 *   STEP=commit    → submit commitment, then wait >= minCommitmentAge (60s)
 *   STEP=register  → register with resolver = ImmunityL1Resolver
 *
 * Run:
 *   IMMUNITY_SEPOLIA_DEPLOYER_PK=0x… RESOLVER=0x… STEP=commit \
 *     node --experimental-strip-types scripts/ens/register-parent-sepolia.ts
 *   # wait 70s, then:
 *   IMMUNITY_SEPOLIA_DEPLOYER_PK=0x… RESOLVER=0x… STEP=register \
 *     node --experimental-strip-types scripts/ens/register-parent-sepolia.ts
 */
import {
  createWalletClient,
  createPublicClient,
  http,
  getAddress,
  formatEther,
  keccak256,
  toHex,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

const RPC = process.env.IMMUNITY_SEPOLIA_RPC ?? "https://ethereum-sepolia-rpc.publicnode.com";
const PK = process.env.IMMUNITY_SEPOLIA_DEPLOYER_PK as Hex | undefined;
if (!PK) throw new Error("set IMMUNITY_SEPOLIA_DEPLOYER_PK=0x…");
const RESOLVER = getAddress(process.env.RESOLVER ?? "");
const STEP = process.env.STEP ?? "commit";

const CONTROLLER = "0xFED6a969AaA60E4961FCD3EBF1A2e8913ac65B72";
const LABEL = process.env.LABEL ?? "immunity";
const DURATION = BigInt(process.env.DURATION ?? 31536000); // 1 year
// Fixed secret so commit + register match across two script runs.
const SECRET = keccak256(toHex("immunity-ccip-parent-v1")) as Hex;

const abi = [
  {
    type: "function",
    name: "makeCommitment",
    stateMutability: "pure",
    inputs: [
      { name: "name", type: "string" },
      { name: "owner", type: "address" },
      { name: "duration", type: "uint256" },
      { name: "secret", type: "bytes32" },
      { name: "resolver", type: "address" },
      { name: "data", type: "bytes[]" },
      { name: "reverseRecord", type: "bool" },
      { name: "ownerControlledFuses", type: "uint16" },
    ],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "commit",
    stateMutability: "nonpayable",
    inputs: [{ name: "commitment", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "register",
    stateMutability: "payable",
    inputs: [
      { name: "name", type: "string" },
      { name: "owner", type: "address" },
      { name: "duration", type: "uint256" },
      { name: "secret", type: "bytes32" },
      { name: "resolver", type: "address" },
      { name: "data", type: "bytes[]" },
      { name: "reverseRecord", type: "bool" },
      { name: "ownerControlledFuses", type: "uint16" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "rentPrice",
    stateMutability: "view",
    inputs: [{ type: "string" }, { type: "uint256" }],
    outputs: [{ components: [{ name: "base", type: "uint256" }, { name: "premium", type: "uint256" }], type: "tuple" }],
  },
  { type: "function", name: "available", stateMutability: "view", inputs: [{ type: "string" }], outputs: [{ type: "bool" }] },
] as const;

async function main() {
  if (RESOLVER === ("0x" as string)) throw new Error("set RESOLVER=0x… (ImmunityL1Resolver on Sepolia)");
  const account = privateKeyToAccount(PK!);
  const transport = http(RPC);
  const pub = createPublicClient({ chain: sepolia, transport });
  const wallet = createWalletClient({ account, chain: sepolia, transport });

  const owner = account.address;
  const fuses = 0;
  const reverseRecord = false;
  const data: Hex[] = [];

  console.log(`controller: ${CONTROLLER}`);
  console.log(`name:       ${LABEL}.eth`);
  console.log(`owner:      ${owner}`);
  console.log(`resolver:   ${RESOLVER}`);
  console.log(`step:       ${STEP}\n`);

  const commitment = (await pub.readContract({
    address: CONTROLLER,
    abi,
    functionName: "makeCommitment",
    args: [LABEL, owner, DURATION, SECRET, RESOLVER, data, reverseRecord, fuses],
  })) as Hex;

  if (STEP === "commit") {
    const available = await pub.readContract({ address: CONTROLLER, abi, functionName: "available", args: [LABEL] });
    if (!available) throw new Error(`${LABEL}.eth is not available`);
    const hash = await wallet.writeContract({ address: CONTROLLER, abi, functionName: "commit", args: [commitment] });
    console.log(`commit tx: ${hash}`);
    await pub.waitForTransactionReceipt({ hash });
    console.log(`✅ committed. Wait >= 60s, then re-run with STEP=register.`);
    return;
  }

  if (STEP === "register") {
    const price = (await pub.readContract({ address: CONTROLLER, abi, functionName: "rentPrice", args: [LABEL, DURATION] })) as { base: bigint; premium: bigint };
    const value = price.base + price.premium;
    // 10% buffer for price drift between quote and tx.
    const sendValue = (value * 110n) / 100n;
    const bal = await pub.getBalance({ address: owner });
    console.log(`rent: ${formatEther(value)} ETH (sending ${formatEther(sendValue)} with buffer); balance ${formatEther(bal)} ETH`);

    const hash = await wallet.writeContract({
      address: CONTROLLER,
      abi,
      functionName: "register",
      args: [LABEL, owner, DURATION, SECRET, RESOLVER, data, reverseRecord, fuses],
      value: sendValue,
    });
    console.log(`register tx: ${hash}`);
    const receipt = await pub.waitForTransactionReceipt({ hash });
    console.log(`✅ registered ${LABEL}.eth (block ${receipt.blockNumber}), resolver = ${RESOLVER}`);
    return;
  }

  throw new Error(`unknown STEP: ${STEP}`);
}

main().catch((e) => {
  console.error(e.shortMessage ?? e.message ?? e);
  process.exitCode = 1;
});
