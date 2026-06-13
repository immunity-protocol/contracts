import hre from "hardhat";
import { namehash } from "ethers";

/**
 * Wire the live PublisherRegistrar onto our own ImmunityL2Registry (Base Sepolia).
 * Deployer-signed (admin of the registry AND owner of the registrar):
 *   1. l2.addRegistrar(PublisherRegistrar)   — authorize mint + setText
 *   2. registrar.setL2Registry(l2)            — point the registrar at our registry
 *
 * The IL2Registry ABI is unchanged, so this is a config swap — NO registrar redeploy.
 * The StubL2Registry stays deployed as a fallback.
 *
 * Run (admin keystore):
 *   IMMUNITY_L2REGISTRY=0x… npx hardhat run scripts/ens/wire-base.ts --network baseSepolia
 *
 * Base Sepolia only — no mainnet.
 */

// Live PublisherRegistrar (DEPLOYED-base-sepolia.md). Override via env if redeployed.
const REGISTRAR = process.env.PUBLISHER_REGISTRAR ?? "0x35F65a08a11f44F73622f51ade1911BC28036faF";
const PARENT_NAME = process.env.PARENT_NAME ?? "immunity.eth";

async function main() {
  const l2 = process.env.IMMUNITY_L2REGISTRY;
  if (!l2) {
    throw new Error("set IMMUNITY_L2REGISTRY=0x… (the deployed ImmunityL2Registry on Base Sepolia)");
  }

  const { ethers } = await hre.network.connect();
  const [signer] = await ethers.getSigners();
  console.log(`deployer: ${await signer.getAddress()}`);
  console.log(`registrar: ${REGISTRAR}`);
  console.log(`ImmunityL2Registry: ${l2}\n`);

  const registrar = await ethers.getContractAt("PublisherRegistrar", REGISTRAR, signer);

  // Guard: parentNode must match the ENS name whose resolver points at our registry,
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

  const l2c = await ethers.getContractAt("ImmunityL2Registry", l2, signer);

  // 1. authorize the registrar on our registry (idempotent)
  if (await l2c.registrars(REGISTRAR)) {
    console.log("addRegistrar: already authorized, skipping");
  } else {
    const tx1 = await l2c.addRegistrar(REGISTRAR);
    console.log(`addRegistrar tx: ${tx1.hash}`);
    await tx1.wait();
    console.log("  confirmed");
  }

  // 2. point the registrar at our registry
  const tx2 = await registrar.setL2Registry(l2);
  console.log(`setL2Registry tx: ${tx2.hash}`);
  await tx2.wait();
  console.log("  confirmed");

  const wired = await registrar.l2registry();
  if (wired.toLowerCase() !== l2.toLowerCase()) {
    throw new Error(`post-check failed: registrar.l2registry()=${wired} != ${l2}`);
  }
  console.log(`\n✅ registrar.l2registry() == ${wired} — wired to ImmunityL2Registry`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
