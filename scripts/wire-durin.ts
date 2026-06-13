import hre from "hardhat";
import { namehash } from "ethers";

/**
 * Wire the live PublisherRegistrar onto a real Durin L2Registry (Base Sepolia).
 * Deployer-signed (the owner of both the Durin registry and the registrar):
 *   1. durin.addRegistrar(PublisherRegistrar)   — authorize mint + setText
 *   2. registrar.setL2Registry(durin)            — point the registrar at real Durin
 *
 * Run (owner keystore):
 *   DURIN_L2REGISTRY=0x… npx hardhat run scripts/wire-durin.ts --network baseSepolia
 *
 * Stub stays deployed as a fallback. Base Sepolia only — no mainnet.
 */

// Live PublisherRegistrar (DEPLOYED-base-sepolia.md). Override via env if redeployed.
const REGISTRAR = process.env.PUBLISHER_REGISTRAR ?? "0x35F65a08a11f44F73622f51ade1911BC28036faF";
const PARENT_NAME = process.env.PARENT_NAME ?? "immunity.eth";

const DURIN_ABI = [
  "function addRegistrar(address registrar) external",
  "function registrars(address) external view returns (bool)",
  "function owner(bytes32 node) external view returns (address)",
];

async function main() {
  const durin = process.env.DURIN_L2REGISTRY;
  if (!durin) throw new Error("set DURIN_L2REGISTRY=0x… (the deployed Durin L2Registry on Base Sepolia)");

  const { ethers } = await hre.network.connect();
  const [signer] = await ethers.getSigners();
  console.log(`deployer: ${await signer.getAddress()}`);
  console.log(`registrar: ${REGISTRAR}`);
  console.log(`durin L2Registry: ${durin}\n`);

  const registrar = await ethers.getContractAt("PublisherRegistrar", REGISTRAR, signer);

  // Guard: parentNode must match the ENS name whose resolver points at Durin,
  // or resolution silently fails.
  const onchainParent = await registrar.parentNode();
  const expectedParent = namehash(PARENT_NAME);
  if (onchainParent.toLowerCase() !== expectedParent.toLowerCase()) {
    throw new Error(
      `registrar.parentNode (${onchainParent}) != namehash(${PARENT_NAME}) (${expectedParent}); ` +
        "set PARENT_NAME to the real test name or fix the registrar's parentNode first",
    );
  }
  console.log(`parentNode OK: namehash(${PARENT_NAME}) = ${expectedParent}\n`);

  const durinC = new ethers.Contract(durin, DURIN_ABI, signer);

  // 1. authorize the registrar on Durin (idempotent)
  if (await durinC.registrars(REGISTRAR)) {
    console.log("addRegistrar: already authorized, skipping");
  } else {
    const tx1 = await durinC.addRegistrar(REGISTRAR);
    console.log(`addRegistrar tx: ${tx1.hash}`);
    await tx1.wait();
    console.log("  confirmed");
  }

  // 2. point the registrar at real Durin
  const tx2 = await registrar.setL2Registry(durin);
  console.log(`setL2Registry tx: ${tx2.hash}`);
  await tx2.wait();
  console.log("  confirmed");

  const wired = await registrar.l2registry();
  if (wired.toLowerCase() !== durin.toLowerCase()) {
    throw new Error(`post-check failed: registrar.l2registry()=${wired} != ${durin}`);
  }
  console.log(`\n✅ registrar.l2registry() == ${wired} — wired to real Durin`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
