/**
 * Set demo text records on the live Base Sepolia ImmunityL2Registry so the
 * CCIP-Read resolution returns real values (Work Package §D).
 *
 * The genesis subnames are CONTRACT-owned (anti-flight), so `setText` is gated
 * to the node owner (the PublisherRegistrar) or an approved registrar. The
 * deployer is the L2Registry ADMIN but not yet a registrar, so this script:
 *   1. addRegistrar(deployer)   — one-time, idempotent (admin-only)
 *   2. setText(node, key, val)  — for each demo record
 *
 * Signed by the deployer/admin. The deployer PK is read from the
 * IMMUNITY_DEPLOYER_PK env var (NEVER committed).
 *
 * Run:
 *   IMMUNITY_DEPLOYER_PK=0x… \
 *   node --experimental-strip-types scripts/ens/set-demo-records.ts
 */
import {
  createWalletClient,
  createPublicClient,
  http,
  namehash,
  getAddress,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const RPC =
  process.env.IMMUNITY_BASE_SEPOLIA_RPC ??
  "https://base-sepolia.g.alchemy.com/v2/C5BdobTzYALqWfs3wDc-I";
const L2 = getAddress(
  process.env.IMMUNITY_L2REGISTRY ?? "0xded674AAbCe67B2cFe724c8c50c928830468E0cC",
);

const PK = process.env.IMMUNITY_DEPLOYER_PK as Hex | undefined;
if (!PK) throw new Error("set IMMUNITY_DEPLOYER_PK=0x… (the L2Registry admin key)");

const abi = [
  { type: "function", name: "admin", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "registrars", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "addRegistrar", stateMutability: "nonpayable", inputs: [{ type: "address" }], outputs: [] },
  { type: "function", name: "setText", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "string" }, { type: "string" }], outputs: [] },
  { type: "function", name: "text", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "string" }], outputs: [{ type: "string" }] },
  { type: "function", name: "owner", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "address" }] },
] as const;

// Demo content per genesis subname (full name → records).
const RECORDS: Record<string, Record<string, string>> = {
  "genesis-1.immunity.eth": {
    "immunity.reputation": "100",
    "immunity.strikes": "0",
    description: "Immunity genesis publisher — reputation mirrored from Base L2.",
    avatar: "https://immunity.eth.limo/avatar/genesis-1.png",
  },
  "genesis-2.immunity.eth": {
    "immunity.reputation": "85",
    "immunity.strikes": "1",
    description: "Immunity genesis publisher (one historical strike).",
  },
};

async function main() {
  const account = privateKeyToAccount(PK!);
  const transport = http(RPC);
  const pub = createPublicClient({ chain: baseSepolia, transport });
  const wallet = createWalletClient({ account, chain: baseSepolia, transport });

  console.log(`signer (admin): ${account.address}`);
  const admin = await pub.readContract({ address: L2, abi, functionName: "admin" });
  console.log(`L2.admin:       ${admin}`);
  if (getAddress(admin) !== account.address) {
    throw new Error("signer is not the L2Registry admin — cannot self-authorize as registrar");
  }

  // Explicit nonce management: the public RPC can lag on `pending`, making viem
  // reuse a nonce ("replacement transaction underpriced"). Track it ourselves
  // and confirm each tx before sending the next.
  let nonce = await pub.getTransactionCount({ address: account.address, blockTag: "pending" });

  // 1. Authorize the admin as a registrar (so it may write text). Idempotent.
  const isReg = await pub.readContract({ address: L2, abi, functionName: "registrars", args: [account.address] });
  if (!isReg) {
    const hash = await wallet.writeContract({ address: L2, abi, functionName: "addRegistrar", args: [account.address], nonce });
    nonce++;
    console.log(`addRegistrar(admin) tx: ${hash}`);
    await pub.waitForTransactionReceipt({ hash });
    console.log("  confirmed");
  } else {
    console.log("addRegistrar: admin already a registrar, skipping");
  }

  // 2. Set the demo records.
  for (const [name, recs] of Object.entries(RECORDS)) {
    const node = namehash(name);
    console.log(`\n${name}  node=${node}`);
    for (const [key, value] of Object.entries(recs)) {
      const existing = await pub.readContract({ address: L2, abi, functionName: "text", args: [node, key] });
      if (existing === value) {
        console.log(`  ${key}: already "${value}", skipping`);
        continue;
      }
      const hash = await wallet.writeContract({ address: L2, abi, functionName: "setText", args: [node, key, value], nonce });
      nonce++;
      await pub.waitForTransactionReceipt({ hash });
      console.log(`  setText ${key} = "${value}"  (${hash})`);
    }
  }

  console.log("\n✅ demo records set. Verify:");
  for (const name of Object.keys(RECORDS)) {
    const node = namehash(name);
    const rep = await pub.readContract({ address: L2, abi, functionName: "text", args: [node, "immunity.reputation"] });
    console.log(`  ${name} immunity.reputation = "${rep}"`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
