import hre from "hardhat";
import ImmunityCore from "../ignition/modules/ImmunityCore.js";

// In-process end-to-end proof of the wired Immunity network. Deploys the SAME
// unified ImmunityCore module programmatically, then drives the full story with
// impersonated multi-EOA interaction and asserts every step. Run with:
//   npx hardhat run scripts/seed-and-verify.ts
//
// This is the local dress rehearsal — it does NOT broadcast to a real network.
// The live deploy is the owner's job (see README).

const STATUS = { PROBATION: 0, ACTIVE: 1, CHALLENGED: 2, SLASHED: 3, EXPIRED: 4 };
const ZERO32 = "0x" + "00".repeat(32);

// Known-bad and protected targets for the demo.
const DRAINER = "0x00000000000000000000000000000000dead0001";
const WETH = "0x4200000000000000000000000000000000000006"; // seeded protected
const NORMAL = "0x00000000000000000000000000000000c0ffee01"; // a non-protected target

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error("ASSERT FAILED: " + msg);
  console.log("  ✓ " + msg);
}

async function main() {
  const conn = await hre.network.connect();
  const ethers = (conn as any).ethers;
  const ignition = (conn as any).ignition;
  if (!ignition) throw new Error("hre ignition plugin not available on this connection");

  const [deployer, checker] = await ethers.getSigners();

  console.log("Deploying ImmunityCore (programmatic, in-process)…");
  const d = await ignition.deploy(ImmunityCore);

  // Re-wrap as ethers contracts bound to the deployer by default.
  const at = async (name: string, fut: any) =>
    ethers.getContractAt(name, await fut.getAddress());
  const usdc = await at("MockUSDC", d.usdc);
  const reputation = await at("Reputation", d.reputation);
  const registrar = await at("PublisherRegistrar", d.registrar);
  const manager = await at("ChallengeManager", d.challengeManager);
  const receiver = await at("CREVerdictReceiver", d.creReceiver);
  const registry = await at("ImmunityRegistry", d.registry);

  const regAddr = await registry.getAddress();
  const repAddr = await reputation.getAddress();

  // ---- 0. Post-deploy wiring assertions (real deps, not stubs) ----
  console.log("\n[0] Wiring");
  assert((await registry.reputation()) === repAddr, "Registry.reputation is the real Reputation");
  assert(
    (await registry.registrar()) === (await registrar.getAddress()),
    "Registry.registrar is the real PublisherRegistrar",
  );
  assert(
    (await registry.challengeManager()) === (await manager.getAddress()),
    "Registry.challengeManager is the real ChallengeManager",
  );
  assert(await reputation.authorizedWriter(regAddr), "Reputation authorizes the Registry as writer");
  assert(
    (await receiver.challengeManager()) === (await manager.getAddress()),
    "CREVerdictReceiver knows the ChallengeManager",
  );
  assert((await registry.protectedMultiplier()) === 1000n, "protectedMultiplier == 1000");
  assert((await registry.corroborationK()) === 3n, "corroborationK == 3");

  // ---- Genesis publishers (the 3 disclosed addresses) ----
  const genesisAddrs: string[] = [
    "0x18628A448938aD61C3AAd97Eca1f99DE310684B4",
    "0xC325Fa14E5E48708b3e1cB16c6fde9D1bed5758E",
    "0xA1E7E10e89dD7EFAc1e7CbDc34015Ce2A1773060",
  ];
  console.log("\n[1] Genesis grants");
  for (const g of genesisAddrs) {
    assert((await reputation.scoreOf(g)) >= 1n, `genesis ${g.slice(0, 8)}… scoreOf ≥ floor`);
  }

  async function impersonate(addr: string) {
    await conn.provider.request({ method: "hardhat_impersonateAccount", params: [addr] });
    await conn.provider.request({
      method: "hardhat_setBalance",
      params: [addr, "0x56BC75E2D63100000"], // 100 ETH
    });
    return ethers.getSigner(addr);
  }

  function params(overrides: any = {}) {
    return {
      abType: 0, // ADDRESS
      flavor: 0,
      verdict: 0, // MALICIOUS
      confidence: 90,
      severity: 80,
      primaryMatcherHash: ethers.id("default"),
      evidenceCid: ethers.id("evidence"),
      contextHash: ethers.id("context"),
      embeddingHash: ZERO32,
      attestation: ethers.id("attestation"),
      expiresAt: 0, // permanent
      reviewer: ethers.ZeroAddress,
      auxiliaryKey: ZERO32,
      ...overrides,
    };
  }

  // ---- 2. Genesis bootstrap: register + deposit + corroborate a seed antibody ----
  console.log("\n[2] Genesis bootstrap (register → publish same drainer ×3)");
  const drainerMatcher = ethers.id("drainer:" + DRAINER);
  const drainerAux = ethers.zeroPadValue(DRAINER, 32);
  const genesisSigners = [];
  for (let i = 0; i < genesisAddrs.length; i++) {
    const g = await impersonate(genesisAddrs[i]);
    genesisSigners.push(g);
    await usdc.mint(g.address, 10_000_000_000n); // 10k USDC
    await usdc.connect(g).approve(await registrar.getAddress(), 10_000_000n); // 10 USDC bond
    await registrar.connect(g).registerPublisher("genesis" + i);
    await usdc.connect(g).approve(regAddr, 5_000_000_000n);
    await registry.connect(g).deposit(5_000_000_000n); // 5k USDC prepaid
    await registry
      .connect(g)
      .publish(params({ primaryMatcherHash: drainerMatcher, auxiliaryKey: drainerAux }));
  }
  assert((await registry.corroborationOf(drainerMatcher)) === 3n, "corroborationOf(drainer) == 3");

  const drainerId = await registry.computeKeccakId(0, 0, drainerMatcher, genesisAddrs[0]);
  await registry.mature(drainerId);
  const drainerAb = await registry.getAntibody(drainerId);
  assert(Number(drainerAb.status) === STATUS.ACTIVE, "seed antibody matured → ACTIVE");
  const ei = await registry.getEnforcementInputs(drainerId);
  assert(Number(ei.corroboration) >= 3, "hard-block-eligible (corroboration ≥ K) at launch");

  // ---- 3. A checker checks a tx to the drainer → matched + settles ----
  console.log("\n[3] Check the drainer");
  await usdc.mint(checker.address, 1_000_000n);
  await usdc.connect(checker).approve(regAddr, 1_000_000n);
  await registry.connect(checker).deposit(1_000_000n);
  const pubBalBefore = await registry.balances(genesisAddrs[0]);
  const settled = await registry
    .connect(checker)
    .check.staticCall(drainerId, DRAINER, 1_000_000n, 8453);
  await registry.connect(checker).check(drainerId, DRAINER, 1_000_000n, 8453);
  assert(settled === true, "check() settled on the matured antibody");
  assert(
    (await registry.balances(genesisAddrs[0])) > pubBalBefore,
    "publisher paid directly (ACTIVE → no escrow)",
  );

  // ---- 4. Flagging a PROTECTED target costs × multiplier and stays advisory ----
  console.log("\n[4] Flag a protected target (WETH)");
  const wethMatcher = ethers.id("weth-flag");
  await registry
    .connect(genesisSigners[0])
    .publish(
      params({ severity: 0, primaryMatcherHash: wethMatcher, auxiliaryKey: ethers.zeroPadValue(WETH, 32) }),
    );
  const wethId = await registry.computeKeccakId(0, 0, wethMatcher, genesisAddrs[0]);
  const wethAb = await registry.getAntibody(wethId);
  assert(wethAb.bondAmount === 1_000_000n * 1000n, "protected flag bond = base × 1000");
  assert(Number(wethAb.prominenceTier) === 1, "prominenceTier == 1 (protected)");
  assert(
    (await registry.corroborationOf(wethMatcher)) === 1n,
    "single flag → corroboration 1 < K → advisory only",
  );

  // ---- 5. Challenge → INVALID Layer-1 verdict → SLASHED ----
  console.log("\n[5] Challenge a false antibody → CRE INVALID → slash");
  const liar = await impersonate("0x00000000000000000000000000000000badac701");
  await usdc.mint(liar.address, 1_000_000_000n);
  await usdc.connect(liar).approve(await registrar.getAddress(), 10_000_000n);
  await registrar.connect(liar).registerPublisher("liar");
  await usdc.connect(liar).approve(regAddr, 100_000_000n);
  await registry.connect(liar).deposit(100_000_000n);
  const falseMatcher = ethers.id("false-flag");
  await registry
    .connect(liar)
    .publish(params({ severity: 50, primaryMatcherHash: falseMatcher, auxiliaryKey: ethers.zeroPadValue(NORMAL, 32) }));
  // Note: liar has scoreOf 0 → corroboration 0 → advisory only (never hard-blocks).
  assert((await registry.corroborationOf(falseMatcher)) === 0n, "low-rep flag has 0 corroboration");
  const falseId = await registry.computeKeccakId(0, 0, falseMatcher, liar.address);

  await usdc.mint(checker.address, 100_000_000n);
  await usdc.connect(checker).approve(await manager.getAddress(), 100_000_000n);
  await manager.connect(checker).challenge(falseId);
  assert(
    Number((await registry.getAntibody(falseId)).status) === STATUS.CHALLENGED,
    "challenge flips antibody → CHALLENGED",
  );

  // deployer is the pinned CRE forwarder → drives a strong INVALID verdict.
  const metadata = ethers.solidityPacked(
    ["bytes32", "bytes10", "address"],
    [ZERO32, "0x" + "00".repeat(10), ethers.ZeroAddress],
  );
  const report = ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "uint16", "uint16"],
    [falseId, 3, 0],
  );
  await receiver.connect(deployer).onReport(metadata, report);
  assert(Number((await registry.getAntibody(falseId)).status) === STATUS.SLASHED, "antibody SLASHED");
  assert(
    (await registry.getAntibodiesByMatcher(falseMatcher)).length === 0,
    "matcher set cleared on slash (C-1)",
  );
  assert(
    (await reputation.getPublisher(liar.address)).slashedCount === 1n,
    "liar reputation slashed",
  );

  // ---- 6. Timeout path → uphold, NO reputation, refund ----
  console.log("\n[6] Challenge timeout → uphold, no reputation");
  const slowMatcher = ethers.id("slow-flag");
  await registry
    .connect(liar)
    .publish(params({ severity: 50, primaryMatcherHash: slowMatcher, auxiliaryKey: ethers.zeroPadValue(DRAINER, 32) }));
  const slowId = await registry.computeKeccakId(0, 0, slowMatcher, liar.address);
  await manager.connect(checker).challenge(slowId);
  const wonBefore = (await reputation.getPublisher(liar.address)).challengesWon;
  await conn.provider.request({ method: "evm_increaseTime", params: ["0xE11"] }); // 3601s
  await conn.provider.request({ method: "evm_mine", params: [] });
  await manager.resolveTimeout(slowId);
  assert(
    Number((await registry.getAntibody(slowId)).status) === STATUS.PROBATION,
    "timeout restores the antibody (no slash)",
  );
  assert(
    (await reputation.getPublisher(liar.address)).challengesWon === wonBefore,
    "timeout credits NO reputation",
  );

  console.log("\n✅ seed-and-verify: the wired Immunity network passes end-to-end.\n");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
