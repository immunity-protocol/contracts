import { expect } from "chai";
import {
  setupRegistryFixture,
  fund,
  registerPublisher,
  makeParams,
  ABTYPE,
  STATUS,
  BOND_BASE,
  PROTECTED_MULT,
  FAR_FUTURE,
} from "./utils.js";

describe("ImmunityRegistry — publish", function () {
  let env: any;

  beforeEach(async function () {
    env = await setupRegistryFixture();
    await fund(env.registry, env.usdc, env.alice, 100_000_000n);
    await registerPublisher(env.registrar, env.reputation, env.alice);
  });

  it("gates publishing to a registered publisher", async function () {
    const { registry, ethers, bob } = env;
    await fund(registry, env.usdc, bob, 10_000_000n);
    // bob is not registered
    await expect(
      registry.connect(bob).publish(makeParams(ethers)),
    ).to.be.revertedWithCustomError(registry, "NotRegistered");
  });

  it("requires a finite future TTL (expiresAt > now)", async function () {
    const { registry, ethers, alice } = env;
    await expect(
      registry.connect(alice).publish(makeParams(ethers, { expiresAt: 0 })),
    ).to.be.revertedWithCustomError(registry, "ExpiryRequired");
  });

  it("creates an antibody in PROBATION and debits the scaled bond", async function () {
    const { registry, ethers, alice } = env;
    const before = await registry.balances(alice.address);

    const params = makeParams(ethers, { severity: 60 });
    const [id] = await registry.connect(alice).publish.staticCall(params);
    await registry.connect(alice).publish(params);

    const ab = await registry.getAntibody(id);
    expect(ab.status).to.equal(STATUS.PROBATION);
    expect(ab.publisher).to.equal(alice.address);

    // severity 60: bond = base + base*60/100 = 1.6 USDC
    const expectedBond = BOND_BASE + (BOND_BASE * 60n) / 100n;
    expect(ab.bondAmount).to.equal(expectedBond);
    expect(ab.escrowedFees).to.equal(0n);
    expect(await registry.balances(alice.address)).to.equal(before - expectedBond);
    expect(await registry.totalBondsLocked()).to.equal(expectedBond);
  });

  it("applies the protected-set multiplier to the bond", async function () {
    const { registry, ethers, alice, protectedSet } = env;
    const target = "0x000000000000000000000000000000000000bEEF";
    await protectedSet.setProtected(target, true);

    const aux = ethers.zeroPadValue(target, 32);
    const params = makeParams(ethers, { severity: 0, auxiliaryKey: aux });
    const [id] = await registry.connect(alice).publish.staticCall(params);
    await registry.connect(alice).publish(params);

    const ab = await registry.getAntibody(id);
    // severity 0 → floor (1 USDC) × protected multiplier (10)
    expect(ab.bondAmount).to.equal(BOND_BASE * PROTECTED_MULT);
    expect(ab.prominenceTier).to.equal(1);
  });

  it("rejects a duplicate (same type/flavor/matcher/publisher)", async function () {
    const { registry, ethers, alice } = env;
    const params = makeParams(ethers);
    await registry.connect(alice).publish(params);
    await expect(
      registry.connect(alice).publish(params),
    ).to.be.revertedWithCustomError(registry, "AntibodyExists");
  });

  it("allows multiple publishers to flag the same target (H-2: no first-claimer)", async function () {
    const { registry, ethers, alice, bob } = env;
    await fund(registry, env.usdc, bob, 100_000_000n);
    await registerPublisher(env.registrar, env.reputation, bob);

    const matcher = ethers.id("shared-target");
    await registry.connect(alice).publish(makeParams(ethers, { primaryMatcherHash: matcher }));
    // bob flagging the SAME matcher must succeed (old contract reverted here)
    await registry.connect(bob).publish(makeParams(ethers, { primaryMatcherHash: matcher }));

    const set = await registry.getAntibodiesByMatcher(matcher);
    expect(set.length).to.equal(2);
  });

  it("reverts when the publisher cannot cover the bond", async function () {
    const { registry, ethers, carol } = env;
    await registerPublisher(env.registrar, env.reputation, carol);
    await fund(registry, env.usdc, carol, 100n); // far less than a bond
    await expect(
      registry.connect(carol).publish(makeParams(ethers)),
    ).to.be.revertedWithCustomError(registry, "InsufficientBalance");
  });

  it("emits Published and the typed auxiliary event", async function () {
    const { registry, ethers, alice } = env;
    const target = "0x00000000000000000000000000000000DeaDBeef";
    const aux = ethers.zeroPadValue(target, 32);
    const params = makeParams(ethers, { auxiliaryKey: aux });
    await expect(registry.connect(alice).publish(params))
      .to.emit(registry, "Published")
      .and.to.emit(registry, "AddressBlocked");
  });
});
