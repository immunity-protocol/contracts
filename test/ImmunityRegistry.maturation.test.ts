import { expect } from "chai";
import {
  setupRegistryFixture,
  fund,
  registerPublisher,
  makeParams,
  STATUS,
  PUBLISHER_SHARE,
} from "./utils.js";

// Publishes the same matcher from `n` distinct registered, reputable publishers
// and returns the first publisher's antibody id (the one we'll mature).
async function corroborate(env: any, matcher: string, signers: any[]) {
  const { registry, ethers } = env;
  const ids: string[] = [];
  for (const s of signers) {
    await fund(registry, env.usdc, s, 100_000_000n);
    await registerPublisher(env.registrar, env.reputation, s);
    const params = makeParams(ethers, { primaryMatcherHash: matcher });
    const [id] = await registry.connect(s).publish.staticCall(params);
    await registry.connect(s).publish(params);
    ids.push(id);
  }
  return ids;
}

describe("ImmunityRegistry — maturation", function () {
  let env: any;

  beforeEach(async function () {
    env = await setupRegistryFixture();
  });

  it("won't mature below the corroboration threshold (K=3)", async function () {
    const { registry, ethers, alice, bob } = env;
    const matcher = ethers.id("threat");
    const [id] = await corroborate(env, matcher, [alice, bob]); // only 2
    expect(await registry.corroborationOf(matcher)).to.equal(2);
    await expect(registry.mature(id)).to.be.revertedWithCustomError(registry, "NotYet");
  });

  it("matures at K corroborators, flips to ACTIVE, releases escrow, signals reputation", async function () {
    const { registry, ethers, alice, bob, carol, dave } = env;
    const matcher = ethers.id("threat");
    const [aliceId] = await corroborate(env, matcher, [alice, bob, carol]);
    expect(await registry.corroborationOf(matcher)).to.equal(3);

    // a checker matches alice's antibody → fee escrows while on PROBATION
    await fund(registry, env.usdc, dave, 10_000_000n);
    await registry.connect(dave).check(aliceId, ethers.ZeroAddress, 0, 0);
    expect((await registry.getAntibody(aliceId)).escrowedFees).to.equal(PUBLISHER_SHARE);

    const balBefore = await registry.balances(alice.address);
    await expect(registry.mature(aliceId))
      .to.emit(registry, "Matured")
      .and.to.emit(registry, "FeesReleased");

    const ab = await registry.getAntibody(aliceId);
    expect(ab.status).to.equal(STATUS.ACTIVE);
    expect(ab.maturedAt).to.be.greaterThan(0n);
    expect(ab.escrowedFees).to.equal(0n);
    expect(await registry.balances(alice.address)).to.equal(balBefore + PUBLISHER_SHARE);
    expect(await registry.totalEscrowed()).to.equal(0n);
    expect(await env.reputation.maturedCalls(alice.address)).to.equal(1n);
  });

  it("pays the publisher directly once ACTIVE (no more escrow)", async function () {
    const { registry, ethers, alice, bob, carol, dave } = env;
    const matcher = ethers.id("threat");
    const [aliceId] = await corroborate(env, matcher, [alice, bob, carol]);
    await registry.mature(aliceId);

    await fund(registry, env.usdc, dave, 10_000_000n);
    const balBefore = await registry.balances(alice.address);
    await registry.connect(dave).check(aliceId, ethers.ZeroAddress, 0, 0);

    expect(await registry.balances(alice.address)).to.equal(balBefore + PUBLISHER_SHARE);
    expect((await registry.getAntibody(aliceId)).escrowedFees).to.equal(0n);
  });

  it("cannot be matured twice (onMatured fires exactly once)", async function () {
    const { registry, ethers, alice, bob, carol } = env;
    const matcher = ethers.id("threat");
    const [aliceId] = await corroborate(env, matcher, [alice, bob, carol]);
    await registry.mature(aliceId);
    await expect(registry.mature(aliceId)).to.be.revertedWithCustomError(
      registry,
      "InvalidStatusTransition",
    );
    expect(await env.reputation.maturedCalls(alice.address)).to.equal(1n);
  });

  it("ignores corroborators below the reputation floor", async function () {
    const { registry, ethers, alice, bob, carol } = env;
    const matcher = ethers.id("threat");
    await corroborate(env, matcher, [alice, bob, carol]);
    // drop carol below the floor (set score 0) — corroboration falls to 2
    await env.reputation.setScore(carol.address, 0n);
    expect(await registry.corroborationOf(matcher)).to.equal(2);
  });
});
