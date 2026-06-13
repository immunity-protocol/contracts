import { expect } from "chai";
import { setupRegistryFixture, fund, makeParams } from "./utils.js";

// Hot-path budget. `check()` runs on every agent action, so it must stay cheap.
// The earliness-weighted fee lottery added a corroboration-set head scan to the
// matched-settlement path (one SLOAD for the set + the matched member's status),
// so the single-member direct-pay case is ~69k. Budget set to 80k to bound it
// with headroom; the full 64-member draw is exercised separately below.
const CHECK_FEE_GAS_BUDGET = 80_000n;

describe("ImmunityRegistry — gas budget", function () {
  let env: any;

  beforeEach(async function () {
    env = await setupRegistryFixture();
    await fund(env.registry, env.usdc, env.bob, 1_000_000n);
  });

  it(`check() direct-pay (ACTIVE) stays under ${CHECK_FEE_GAS_BUDGET} gas`, async function () {
    const { registry, ethers, owner, bob } = env;
    // Seeded antibody starts ACTIVE+matured → direct-pay settlement path.
    const params = makeParams(ethers, { primaryMatcherHash: ethers.id("seeded-hot") });
    await registry.seedAntibody(params);
    const id = await registry.computeKeccakId(0, 0, ethers.id("seeded-hot"), owner.address);

    await registry.connect(bob).check(id, ethers.ZeroAddress, 0n, 0n); // warm storage
    const tx = await registry.connect(bob).check(id, ethers.ZeroAddress, 0n, 0n);
    const receipt = await tx.wait();
    console.log(`        check() direct-pay gas used: ${receipt.gasUsed}`);
    expect(receipt.gasUsed).to.be.lt(CHECK_FEE_GAS_BUDGET);
  });

  it("check() against a full 64-member matured set stays within a sane bound", async function () {
    const { registry, ethers, owner, bob } = env;
    const matcher = ethers.id("crowded-threat");
    // Build 64 ACTIVE (seeded → matured) members under one matcher. Vary `flavor`
    // so each (abType, flavor, matcher, owner) keccakId is distinct (no collision).
    const SCAN = 64;
    let firstId = "";
    for (let flavor = 0; flavor < SCAN; flavor++) {
      const params = makeParams(ethers, { primaryMatcherHash: matcher, flavor });
      await registry.seedAntibody(params);
      if (flavor === 0) {
        firstId = await registry.computeKeccakId(0, flavor, matcher, owner.address);
      }
    }

    await registry.connect(bob).check(firstId, ethers.ZeroAddress, 0n, 0n); // warm
    const tx = await registry.connect(bob).check(firstId, ethers.ZeroAddress, 0n, 0n);
    const receipt = await tx.wait();
    console.log(`        check() 64-member lottery gas used: ${receipt.gasUsed}`);
    // Worst case: MAX_CORROBORATION_SCAN (64) members, all warm SLOADs for status +
    // publisher plus two in-memory weight arrays. This is the upper bound on the
    // hot path and stays an order of magnitude under the block gas limit; a
    // 64-member fully-matured set is a rare extreme (K to mature is only 3).
    expect(receipt.gasUsed).to.be.lt(600_000n);
  });

  it(`check() no-match stays under ${CHECK_FEE_GAS_BUDGET} gas`, async function () {
    const { registry, ethers, bob } = env;
    await registry.connect(bob).check(ethers.ZeroHash, ethers.ZeroAddress, 0n, 0n); // warm
    const tx = await registry.connect(bob).check(ethers.ZeroHash, ethers.ZeroAddress, 0n, 0n);
    const receipt = await tx.wait();
    console.log(`        check() no-match gas used:  ${receipt.gasUsed}`);
    expect(receipt.gasUsed).to.be.lt(CHECK_FEE_GAS_BUDGET);
  });
});
