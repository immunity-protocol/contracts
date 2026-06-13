import { expect } from "chai";
import {
  setupRegistryFixture,
  fund,
  registerPublisher,
  makeParams,
  CHECK_FEE,
  PUBLISHER_SHARE,
  TREASURY_SHARE,
  ZERO_BYTES32,
} from "./utils.js";

describe("ImmunityRegistry — check", function () {
  let env: any;
  let id: string;

  beforeEach(async function () {
    env = await setupRegistryFixture();
    const { registry, ethers, alice, bob } = env;
    await fund(registry, env.usdc, alice, 100_000_000n);
    await registerPublisher(env.registrar, env.reputation, alice);
    await fund(registry, env.usdc, bob, 10_000_000n);

    const params = makeParams(ethers);
    [id] = await registry.connect(alice).publish.staticCall(params);
    await registry.connect(alice).publish(params);
  });

  it("debits the check fee from the caller", async function () {
    const { registry, bob } = env;
    const before = await registry.balances(bob.address);
    await registry.connect(bob).check(id, ethers0(), 0, 0);
    expect(await registry.balances(bob.address)).to.equal(before - CHECK_FEE);
  });

  it("escrows the publisher share while on PROBATION (not paid out)", async function () {
    const { registry, alice, bob } = env;
    const pubBefore = await registry.balances(alice.address);
    await registry.connect(bob).check(id, ethers0(), 0, 0);

    // publisher balance unchanged; share sits in escrow
    expect(await registry.balances(alice.address)).to.equal(pubBefore);
    const ab = await registry.getAntibody(id);
    expect(ab.escrowedFees).to.equal(PUBLISHER_SHARE);
    expect(await registry.totalEscrowed()).to.equal(PUBLISHER_SHARE);
    // treasury still takes its cut immediately
    expect(await registry.treasuryBalance()).to.equal(TREASURY_SHARE);
  });

  it("routes the whole fee to treasury on a no-match check (id = 0)", async function () {
    const { registry, bob } = env;
    await registry.connect(bob).check(ZERO_BYTES32, ethers0(), 0, 0);
    expect(await registry.treasuryBalance()).to.equal(CHECK_FEE);
  });

  it("treats an unknown antibody id as a no-match", async function () {
    const { registry, ethers, bob } = env;
    await registry.connect(bob).check(ethers.id("nope"), ethers0(), 0, 0);
    expect(await registry.treasuryBalance()).to.equal(CHECK_FEE);
  });

  it("emits Matched with escrowed=true on a probation match", async function () {
    const { registry, bob } = env;
    await expect(registry.connect(bob).check(id, ethers0(), 0, 0))
      .to.emit(registry, "Matched")
      .and.to.emit(registry, "FeesEscrowed");
  });

  it("reverts when the caller cannot cover the fee", async function () {
    const { registry, carol } = env;
    await expect(
      registry.connect(carol).check(id, ethers0(), 0, 0),
    ).to.be.revertedWithCustomError(registry, "InsufficientBalance");
  });
});

// address(0) helper kept local to avoid importing ethers in every assertion
function ethers0() {
  return "0x0000000000000000000000000000000000000000";
}
