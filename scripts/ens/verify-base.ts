import hre from "hardhat";
import { Wallet } from "ethers";

/**
 * Phase-1 (Base-only) proof of the B-5 guarantees against the LIVE
 * ImmunityL2Registry — no CCIP, no L1. Verifies the protocol-critical invariants
 * that hold regardless of third-party ENS resolution:
 *   1. registerPublisher mints a CONTRACT-OWNED subname (anti-flight)
 *   2. syncReputation writes the reputation mirror via the registrar
 *   3. a non-authorized EOA setText on the node REVERTS (un-forgeable mirror)
 *
 * Run (needs a funded Base Sepolia TEST wallet):
 *   IMMUNITY_L2REGISTRY=0x… TEST_PK=0x… \
 *     npx hardhat run scripts/ens/verify-base.ts --network baseSepolia
 *
 * Base Sepolia only — no mainnet.
 */

const REGISTRAR = process.env.PUBLISHER_REGISTRAR ?? "0x35F65a08a11f44F73622f51ade1911BC28036faF";
const USDC = process.env.USDC ?? "0x26265722fa5d94bB3A3C866124aDdC7b85670b16";
const LABEL = process.env.LABEL ?? "imm-test";
const ZERO_NODE = "0x" + "00".repeat(32);

const USDC_ABI = [
  "function mint(address to, uint256 amount) external",
  "function approve(address spender, uint256 amount) external returns (bool)",
];
const L2_ABI = [
  "function owner(bytes32 node) external view returns (address)",
  "function registrars(address) external view returns (bool)",
  "function text(bytes32 node, string key) external view returns (string)",
  "function setText(bytes32 node, string key, string value) external",
];

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error("ASSERT FAILED: " + msg);
  console.log("  ✓ " + msg);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Send a tx, wait for it, then poll until the node reports no in-flight tx for
 * the sender (pending nonce == latest nonce). Retries on the RPC's "in-flight
 * transaction limit reached for delegated accounts" error — EIP-7702 smart
 * wallets are capped to one in-flight tx and the node lags a beat after mining.
 */
async function sendSettled(provider: any, from: string, label: string, fn: () => Promise<any>) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const tx = await fn();
      await tx.wait();
      for (let i = 0; i < 10; i++) {
        const [latest, pending] = await Promise.all([
          provider.getTransactionCount(from, "latest"),
          provider.getTransactionCount(from, "pending"),
        ]);
        if (latest === pending) break;
        await sleep(1500);
      }
      return tx;
    } catch (e: any) {
      if (String(e?.message ?? e).includes("in-flight transaction limit")) {
        console.log(`  ${label}: in-flight limit, retrying in 3s…`);
        await sleep(3000);
        continue;
      }
      throw e;
    }
  }
  throw new Error(`${label}: exhausted retries (in-flight limit)`);
}

async function main() {
  const l2 = process.env.IMMUNITY_L2REGISTRY;
  const testPk = process.env.TEST_PK;
  if (!l2) throw new Error("set IMMUNITY_L2REGISTRY=0x… (deployed ImmunityL2Registry)");
  if (!testPk) throw new Error("set TEST_PK=0x… (a funded Base Sepolia test wallet)");

  const { ethers } = await hre.network.connect();
  const provider = ethers.provider;
  const test = new Wallet(testPk, provider);
  console.log(`test wallet: ${test.address}`);
  console.log(`ImmunityL2Registry: ${l2}\n`);

  const registrar = await ethers.getContractAt("PublisherRegistrar", REGISTRAR, test);
  const usdc = new ethers.Contract(USDC, USDC_ABI, test);
  const l2Read = new ethers.Contract(l2, L2_ABI, provider);

  console.log("[0] wiring");
  assert(
    (await registrar.l2registry()).toLowerCase() === l2.toLowerCase(),
    "registrar.l2registry() == ImmunityL2Registry",
  );
  assert(await l2Read.registrars(REGISTRAR), "registrar is an approved registrar on the registry");

  console.log("\n[1] register a contract-owned subname");
  if (await registrar.isRegistered(test.address)) {
    console.log("  (test wallet already registered — reusing its subname)");
  } else {
    const bond = await registrar.registrationBond();
    await sendSettled(provider, test.address, "mint", () => usdc.mint(test.address, bond));
    await sendSettled(provider, test.address, "approve", () => usdc.approve(REGISTRAR, bond));
    await sendSettled(provider, test.address, "registerPublisher", () =>
      registrar.registerPublisher(LABEL),
    );
  }
  const node = await registrar.nodeOf(test.address);
  assert(node !== ZERO_NODE, `subname node minted: ${node}`);
  assert(
    (await l2Read.owner(node)).toLowerCase() === REGISTRAR.toLowerCase(),
    "subname is owned by the PublisherRegistrar contract (NOT the test wallet)",
  );

  console.log("\n[2] reputation mirror + un-forgeability");
  await sendSettled(provider, test.address, "syncReputation", () =>
    registrar.syncReputation(test.address),
  );
  console.log(`  immunity.reputation = ${await l2Read.text(node, "immunity.reputation")}`);
  console.log(`  immunity.strikes    = ${await l2Read.text(node, "immunity.strikes")}`);
  let forgeReverted = false;
  try {
    await (new ethers.Contract(l2, L2_ABI, test) as any).setText.staticCall(
      node,
      "immunity.reputation",
      "999999",
    );
  } catch {
    forgeReverted = true;
  }
  assert(forgeReverted, "a non-authorized EOA setText on the node REVERTS (B-5)");

  console.log("\n✅ Phase-1 B-5 guarantees verified on Base Sepolia.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
