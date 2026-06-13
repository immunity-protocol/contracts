import { expect } from "chai";
import { setupRegistryFixture, fund, makeParams } from "./utils.js";

// Hot-path budget. `check()` runs on every agent action, so it must stay cheap.
// v1 dropped the opportunistic FIFO sweep from the hot path entirely, so the
// budget is the old 65k with comfortable headroom.
const CHECK_FEE_GAS_BUDGET = 65_000n;

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

  it(`check() no-match stays under ${CHECK_FEE_GAS_BUDGET} gas`, async function () {
    const { registry, ethers, bob } = env;
    await registry.connect(bob).check(ethers.ZeroHash, ethers.ZeroAddress, 0n, 0n); // warm
    const tx = await registry.connect(bob).check(ethers.ZeroHash, ethers.ZeroAddress, 0n, 0n);
    const receipt = await tx.wait();
    console.log(`        check() no-match gas used:  ${receipt.gasUsed}`);
    expect(receipt.gasUsed).to.be.lt(CHECK_FEE_GAS_BUDGET);
  });
});
