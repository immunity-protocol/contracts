import hre from "hardhat";
import { Wallet } from "ethers";
import { createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";
import { normalize } from "viem/ens";

/**
 * End-to-end ENS/Durin proof (Base Sepolia + Sepolia ENS).
 * Run (owner; needs a funded TEST wallet + Alchemy Sepolia):
 *   DURIN_L2REGISTRY=0x… TEST_PK=0x… ENS_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/KEY \
 *     npx hardhat run scripts/verify-ens.ts --network baseSepolia
 *
 * Proves: registerPublisher mints a CONTRACT-OWNED subname (B-5 anti-flight);
 * a non-authorized EOA setText reverts (B-5 un-forgeable mirror); and
 * <label>.immunity.eth resolves via CCIP-read from L1.
 */

const REGISTRAR = process.env.PUBLISHER_REGISTRAR ?? "0x35F65a08a11f44F73622f51ade1911BC28036faF";
const USDC = process.env.USDC ?? "0x26265722fa5d94bB3A3C866124aDdC7b85670b16";
const PARENT_NAME = process.env.PARENT_NAME ?? "immunity.eth";
const LABEL = process.env.LABEL ?? "imm-test";

const USDC_ABI = [
  "function mint(address to, uint256 amount) external",
  "function approve(address spender, uint256 amount) external returns (bool)",
];
const DURIN_ABI = [
  "function owner(bytes32 node) external view returns (address)",
  "function text(bytes32 node, string key) external view returns (string)",
  "function setText(bytes32 node, string key, string value) external",
];

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error("ASSERT FAILED: " + msg);
  console.log("  ✓ " + msg);
}

async function main() {
  const durin = process.env.DURIN_L2REGISTRY;
  const testPk = process.env.TEST_PK;
  const ensRpc = process.env.ENS_RPC_URL;
  if (!durin) throw new Error("set DURIN_L2REGISTRY=0x…");
  if (!testPk) throw new Error("set TEST_PK=0x… (a funded Base Sepolia test wallet)");
  if (!ensRpc) throw new Error("set ENS_RPC_URL=… (Alchemy Sepolia for CCIP L1 reads)");

  const { ethers } = await hre.network.connect();
  const provider = ethers.provider;
  const test = new Wallet(testPk, provider);
  console.log(`test wallet: ${test.address}\n`);

  const registrar = await ethers.getContractAt("PublisherRegistrar", REGISTRAR, test);
  const usdc = new ethers.Contract(USDC, USDC_ABI, test);
  const durinRead = new ethers.Contract(durin, DURIN_ABI, provider);

  console.log("[1] register a contract-owned subname");
  if (await registrar.isRegistered(test.address)) {
    console.log("  (test wallet already registered — reusing its subname)");
  } else {
    const bond = await registrar.registrationBond();
    await (await usdc.mint(test.address, bond)).wait();
    await (await usdc.approve(REGISTRAR, bond)).wait();
    await (await registrar.registerPublisher(LABEL)).wait();
  }
  const node = await registrar.nodeOf(test.address);
  assert(node !== "0x" + "00".repeat(32), `subname node minted: ${node}`);
  assert(
    (await durinRead.owner(node)).toLowerCase() === REGISTRAR.toLowerCase(),
    "subname is owned by the PublisherRegistrar contract (NOT the test wallet)",
  );

  console.log("\n[2] reputation mirror + un-forgeability");
  await (await registrar.syncReputation(test.address)).wait();
  console.log(`  immunity.reputation = ${await durinRead.text(node, "immunity.reputation")}`);
  let forgeReverted = false;
  try {
    await (
      new ethers.Contract(durin, DURIN_ABI, test) as any
    ).setText.staticCall(node, "immunity.reputation", "999999");
  } catch {
    forgeReverted = true;
  }
  assert(forgeReverted, "a non-authorized EOA setText on the node REVERTS (B-5)");

  console.log("\n[3] CCIP-read resolution from Sepolia L1");
  const client = createPublicClient({ chain: sepolia, transport: http(ensRpc) });
  const fqdn = normalize(`${LABEL}.${PARENT_NAME}`);
  const addr = await client.getEnsAddress({ name: fqdn }).catch((e) => {
    console.error("  resolution error:", e.shortMessage ?? e.message);
    return null;
  });
  console.log(`  ${fqdn} → address: ${addr ?? "(none)"}`);
  const rep = await client.getEnsText({ name: fqdn, key: "immunity.reputation" }).catch(() => null);
  console.log(`  ${fqdn} → immunity.reputation: ${rep ?? "(unset)"}`);
  assert(addr !== null, `${fqdn} resolves via CCIP-read (L1 → Durin L2Registry)`);

  console.log("\n✅ ENS/Durin E2E verified.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
