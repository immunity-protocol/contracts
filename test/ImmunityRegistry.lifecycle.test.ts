import { expect } from "chai";
import {
  setupRegistryFixture,
  fund,
  registerPublisher,
  makeParams,
  STATUS,
  PUBLISHER_SHARE,
  increaseTime,
} from "./utils.js";

describe("ImmunityRegistry — TTL lifecycle (expire / sweep / retire)", function () {
  let env: any;
  const SOON = 3600; // 1 hour

  beforeEach(async function () {
    env = await setupRegistryFixture();
    await fund(env.registry, env.usdc, env.alice, 100_000_000n);
    await registerPublisher(env.registrar, env.reputation, env.alice);
  });

  async function publishWithTTL(ttlSeconds: number, label = "primary") {
    const { registry, ethers, alice } = env;
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    const params = makeParams(ethers, {
      expiresAt: now + ttlSeconds,
      primaryMatcherHash: ethers.id(label),
    });
    const [id] = await registry.connect(alice).publish.staticCall(params);
    await registry.connect(alice).publish(params);
    return id;
  }

  it("won't expire before the TTL passes", async function () {
    const { registry } = env;
    const id = await publishWithTTL(SOON);
    await expect(registry.expire(id)).to.be.revertedWithCustomError(registry, "NotYet");
  });

  it("expires after TTL: releases bond, claws never-matured escrow, clears matcher", async function () {
    const { registry, ethers, alice, bob } = env;
    const id = await publishWithTTL(SOON);
    const ab0 = await registry.getAntibody(id);

    // accrue some escrow while on PROBATION
    await fund(registry, env.usdc, bob, 10_000_000n);
    await registry.connect(bob).check(id, ethers.ZeroAddress, 0, 0);
    expect(await registry.totalEscrowed()).to.equal(PUBLISHER_SHARE);

    const balBefore = await registry.balances(alice.address);
    const treasuryBefore = await registry.treasuryBalance();

    await increaseTime(ethers, SOON + 1);
    await expect(registry.expire(id))
      .to.emit(registry, "Expired")
      .and.to.emit(registry, "BondReleased")
      .and.to.emit(registry, "FeesClawedBack");

    const ab = await registry.getAntibody(id);
    expect(ab.status).to.equal(STATUS.EXPIRED);
    // bond returned to publisher; escrow clawed to treasury (never matured)
    expect(await registry.balances(alice.address)).to.equal(balBefore + ab0.bondAmount);
    expect(await registry.treasuryBalance()).to.equal(treasuryBefore + PUBLISHER_SHARE);
    expect(await registry.totalBondsLocked()).to.equal(0n);
    expect(await registry.totalEscrowed()).to.equal(0n);

    const set = await registry.getAntibodiesByMatcher(ab.primaryMatcherHash);
    expect(set.length).to.equal(0);
  });

  it("sweepExpired batch-expires only the eligible ids", async function () {
    const { registry, ethers, alice } = env;
    const a = await publishWithTTL(SOON, "sweep-a");
    const b = await publishWithTTL(SOON * 100, "sweep-b"); // not yet expired
    await increaseTime(ethers, SOON + 1);

    const n = await registry.sweepExpired.staticCall([a, b]);
    expect(n).to.equal(1n);
    await registry.sweepExpired([a, b]);

    expect((await registry.getAntibody(a)).status).to.equal(STATUS.EXPIRED);
    expect((await registry.getAntibody(b)).status).to.equal(STATUS.PROBATION);
  });

  it("permanent antibody (expiresAt = 0): publishes, settles, matures, but never expires", async function () {
    const { registry, ethers, alice, bob, carol, dave } = env;
    const matcher = ethers.id("permanent-threat");

    // publishes OK with expiresAt = 0
    await registry.connect(alice).publish(makeParams(ethers, { expiresAt: 0, primaryMatcherHash: matcher }));
    const id = await registry.computeKeccakId(0, 0, matcher, alice.address);
    expect((await registry.getAntibody(id)).expiresAt).to.equal(0n);

    // check() still settles to it (escrows on PROBATION)
    await fund(registry, env.usdc, dave, 10_000_000n);
    await registry.connect(dave).check(id, ethers.ZeroAddress, 0, 0);
    expect((await registry.getAntibody(id)).escrowedFees).to.equal(PUBLISHER_SHARE);

    // expire() and sweepExpired() must NOT remove a permanent antibody
    await increaseTime(ethers, 10 * 365 * 24 * 3600); // 10 years on
    await expect(registry.expire(id)).to.be.revertedWithCustomError(registry, "NotYet");
    expect(await registry.sweepExpired.staticCall([id])).to.equal(0n);

    // mature() still works (corroborate it)
    for (const s of [bob, carol]) {
      await fund(registry, env.usdc, s, 100_000_000n);
      await registerPublisher(env.registrar, env.reputation, s);
      await registry.connect(s).publish(makeParams(ethers, { expiresAt: 0, primaryMatcherHash: matcher }));
    }
    await registry.mature(id);
    expect((await registry.getAntibody(id)).status).to.equal(STATUS.ACTIVE);
  });

  it("permanent antibody can still be challenged and slashed", async function () {
    const { registry, ethers, alice, challengeManager, challenger } = env;
    const matcher = ethers.id("permanent-bad");
    await registry.connect(alice).publish(makeParams(ethers, { expiresAt: 0, primaryMatcherHash: matcher }));
    const id = await registry.computeKeccakId(0, 0, matcher, alice.address);

    await registry.connect(challengeManager).onChallengeOpened(id);
    await registry.connect(challengeManager).onChallengeResolved(id, true, challenger.address);
    expect((await registry.getAntibody(id)).status).to.equal(STATUS.SLASHED);
  });

  it("finite expiry must be in the future at publish, and expires after the timestamp", async function () {
    const { registry, ethers, alice } = env;
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    // a past finite expiry is rejected
    await expect(
      registry.connect(alice).publish(makeParams(ethers, { expiresAt: now - 1, primaryMatcherHash: ethers.id("past") })),
    ).to.be.revertedWithCustomError(registry, "ExpiryRequired");

    // a future finite expiry behaves as before
    const id = await publishWithTTL(SOON, "finite-ttl");
    await expect(registry.expire(id)).to.be.revertedWithCustomError(registry, "NotYet");
    await increaseTime(ethers, SOON + 1);
    await registry.expire(id);
    expect((await registry.getAntibody(id)).status).to.equal(STATUS.EXPIRED);
  });

  it("retire: only the publisher, returns bond, clears matcher", async function () {
    const { registry, ethers, alice, bob } = env;
    const id = await publishWithTTL(SOON * 100);
    const ab0 = await registry.getAntibody(id);

    await expect(registry.connect(bob).retire(id)).to.be.revertedWithCustomError(
      registry,
      "NotPublisher",
    );

    const balBefore = await registry.balances(alice.address);
    await expect(registry.connect(alice).retire(id)).to.emit(registry, "Retired");
    expect(await registry.balances(alice.address)).to.equal(balBefore + ab0.bondAmount);
    expect((await registry.getAntibody(id)).status).to.equal(STATUS.EXPIRED);
    expect((await registry.getAntibodiesByMatcher(ab0.primaryMatcherHash)).length).to.equal(0);
  });
});
