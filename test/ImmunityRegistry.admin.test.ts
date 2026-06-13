import { expect } from "chai";
import {
  setupRegistryFixture,
  fund,
  registerPublisher,
  makeParams,
  STATUS,
  BOND_BASE,
} from "./utils.js";

describe("ImmunityRegistry — admin", function () {
  let env: any;

  beforeEach(async function () {
    env = await setupRegistryFixture();
  });

  it("only the owner can set params / pause / withdraw treasury", async function () {
    const { registry, alice } = env;
    await expect(
      registry.connect(alice).setBondParams(1n, 1n, 1n),
    ).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
    await expect(registry.connect(alice).pause()).to.be.revertedWithCustomError(
      registry,
      "OwnableUnauthorizedAccount",
    );
    await expect(
      registry.connect(alice).withdrawTreasury(1n, alice.address),
    ).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
  });

  it("setBondParams changes computeBond", async function () {
    const { registry, ethers } = env;
    await registry.setBondParams(2_000_000n, 2_000_000n, 5n);
    // severity 0 → floor 2 USDC
    expect(await registry.computeBond(0, ethers.ZeroAddress)).to.equal(2_000_000n);
  });

  it("setMaturationParams rejects K=0 and updates the threshold", async function () {
    const { registry } = env;
    await expect(registry.setMaturationParams(0, 1n, 0n)).to.be.revertedWithCustomError(
      registry,
      "ZeroAmount",
    );
    await registry.setMaturationParams(1, 5n, 0n);
    expect(await registry.corroborationK()).to.equal(1);
    expect(await registry.minCorroborationRep()).to.equal(5n);
  });

  it("pause blocks publish and check; unpause restores", async function () {
    const { registry, ethers, alice } = env;
    await fund(registry, env.usdc, alice, 100_000_000n);
    await registerPublisher(env.registrar, env.reputation, alice);
    await registry.pause();
    await expect(
      registry.connect(alice).publish(makeParams(ethers)),
    ).to.be.revertedWithCustomError(registry, "EnforcedPause");
    await registry.unpause();
    await expect(registry.connect(alice).publish(makeParams(ethers))).to.emit(
      registry,
      "Published",
    );
  });

  it("seedAntibody mints a genesis antibody: no bond, starts ACTIVE+matured", async function () {
    const { registry, ethers, owner } = env;
    const params = makeParams(ethers, { primaryMatcherHash: ethers.id("genesis") });
    const [id] = await registry.seedAntibody.staticCall(params);
    await expect(registry.seedAntibody(params)).to.emit(registry, "Seeded");
    const ab = await registry.getAntibody(id);
    expect(ab.status).to.equal(STATUS.ACTIVE);
    expect(ab.isSeeded).to.equal(1);
    expect(ab.bondAmount).to.equal(0n);
    expect(ab.maturedAt).to.be.greaterThan(0n);
  });

  it("withdrawTreasury moves accrued USDC out", async function () {
    const { registry, ethers, alice, bob, owner, usdc } = env;
    await fund(registry, usdc, alice, 100_000_000n);
    await registerPublisher(env.registrar, env.reputation, alice);
    await registry.connect(alice).publish(makeParams(ethers));
    await fund(registry, usdc, bob, 10_000_000n);
    await registry.connect(bob).check(ethers.id("x"), ethers.ZeroAddress, 0, 0); // no-match → full fee to treasury

    const treasury = await registry.treasuryBalance();
    expect(treasury).to.be.greaterThan(0n);
    const ownerBalBefore = await usdc.balanceOf(owner.address);
    await registry.withdrawTreasury(treasury, owner.address);
    expect(await usdc.balanceOf(owner.address)).to.equal(ownerBalBefore + treasury);
    expect(await registry.treasuryBalance()).to.equal(0n);
  });
});
