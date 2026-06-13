import { expect } from "chai";
import {
  setupRegistryFixture,
  fund,
  registerPublisher,
  makeParams,
  STATUS,
  PUBLISHER_SHARE,
} from "./utils.js";

// USDC held by the contract must always equal the sum of every claim against it.
async function assertConservation(env: any, accounts: any[]) {
  const { registry, usdc } = env;
  const held = await usdc.balanceOf(await registry.getAddress());
  let sumBalances = 0n;
  for (const a of accounts) sumBalances += await registry.balances(a.address);
  const treasury = await registry.treasuryBalance();
  const bonds = await registry.totalBondsLocked();
  const escrow = await registry.totalEscrowed();
  expect(held).to.equal(sumBalances + treasury + bonds + escrow);
}

// Publish `matcher` from each signer (distinct registered, reputable publishers),
// then mature every antibody so the whole corroboration set is ACTIVE/enforcing.
// Returns ids in publish order (index 0 = earliest).
async function corroborateAndMatureAll(env: any, matcher: string, signers: any[]) {
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
  // K=3 reached → mature each so all become ACTIVE.
  for (const id of ids) await registry.mature(id);
  return ids;
}

describe("ImmunityRegistry — fee lottery", function () {
  let env: any;
  let accounts: any[];

  beforeEach(async function () {
    env = await setupRegistryFixture();
    accounts = [
      env.owner,
      env.alice,
      env.bob,
      env.carol,
      env.dave,
      env.challengeManager,
      env.challenger,
    ];
  });

  it("single matured member: always pays that member", async function () {
    const { registry, ethers, owner, bob } = env;
    const matcher = ethers.id("solo");
    // Seeded antibody is the lone ACTIVE member of its matcher set.
    await registry.seedAntibody(makeParams(ethers, { primaryMatcherHash: matcher }));
    const id = await registry.computeKeccakId(0, 0, matcher, owner.address);

    await fund(registry, env.usdc, bob, 10_000_000n);
    const before = await registry.balances(owner.address);
    await registry.connect(bob).check(id, ethers.ZeroAddress, 0, 0);
    expect(await registry.balances(owner.address)).to.equal(before + PUBLISHER_SHARE);
    await assertConservation(env, accounts);
  });

  it("advisory (not-yet-matured) set: escrows to the passed antibody's publisher, no lottery", async function () {
    const { registry, ethers, alice, bob, carol, dave } = env;
    const matcher = ethers.id("advisory");
    const ids: string[] = [];
    for (const s of [alice, bob, carol]) {
      await fund(registry, env.usdc, s, 100_000_000n);
      await registerPublisher(env.registrar, env.reputation, s);
      const params = makeParams(ethers, { primaryMatcherHash: matcher });
      const [id] = await registry.connect(s).publish.staticCall(params);
      await registry.connect(s).publish(params);
      ids.push(id);
    }
    // NONE matured yet (all PROBATION) → advisory set: escrow to the passed pub.
    const carolId = ids[2];
    await fund(registry, env.usdc, dave, 10_000_000n);
    const carolBalBefore = await registry.balances(carol.address);
    await registry.connect(dave).check(carolId, ethers.ZeroAddress, 0, 0);

    const ab = await registry.getAntibody(carolId);
    expect(ab.escrowedFees).to.equal(PUBLISHER_SHARE);
    // carol was not paid directly — the share sits in escrow against her antibody.
    expect(await registry.balances(carol.address)).to.equal(carolBalBefore);
    // no other member's antibody received escrow
    expect((await registry.getAntibody(ids[0])).escrowedFees).to.equal(0n);
    expect((await registry.getAntibody(ids[1])).escrowedFees).to.equal(0n);
    expect(await registry.totalEscrowed()).to.equal(PUBLISHER_SHARE);
    await assertConservation(env, accounts);
  });

  it("conservation holds across many lottery payouts", async function () {
    const { registry, ethers, alice, bob, carol, dave } = env;
    const matcher = ethers.id("threat-conserve");
    const ids = await corroborateAndMatureAll(env, matcher, [alice, bob, carol]);
    await assertConservation(env, accounts);

    await fund(registry, env.usdc, dave, 100_000_000n);
    for (let i = 0; i < 50; i++) {
      // Always reference the earliest antibody (mirrors the SDK), but the lottery
      // spreads the payout across the matured set.
      await registry.connect(dave).check(ids[0], ethers.ZeroAddress, 0, 0);
      if (i % 10 === 0) await assertConservation(env, accounts);
    }
    await assertConservation(env, accounts);
  });

  it("distribution skew: the earliest corroborator wins materially more than the latest", async function () {
    const { registry, ethers, alice, bob, carol, dave } = env;
    const matcher = ethers.id("threat-skew");
    // alice = earliest (rank 0, heaviest), carol = latest (rank 2, lightest).
    const ids = await corroborateAndMatureAll(env, matcher, [alice, bob, carol]);

    await fund(registry, env.usdc, dave, 1_000_000_000n);

    const earnedBefore = {
      alice: (await registry.getPublisherStats(alice.address)).totalEarned,
      bob: (await registry.getPublisherStats(bob.address)).totalEarned,
      carol: (await registry.getPublisherStats(carol.address)).totalEarned,
    };

    const N = 400;
    for (let i = 0; i < N; i++) {
      // checkNonce auto-increments each draw, so successive same-block checks draw
      // differently; also stir prevrandao periodically for good measure.
      if (i % 25 === 0) {
        await ethers.provider.send("hardhat_setPrevRandao", [
          "0x" + (i + 1).toString(16).padStart(64, "0"),
        ]);
      }
      await registry.connect(dave).check(ids[0], ethers.ZeroAddress, 0, 0);
    }

    const aliceWins =
      ((await registry.getPublisherStats(alice.address)).totalEarned - earnedBefore.alice) /
      PUBLISHER_SHARE;
    const bobWins =
      ((await registry.getPublisherStats(bob.address)).totalEarned - earnedBefore.bob) /
      PUBLISHER_SHARE;
    const carolWins =
      ((await registry.getPublisherStats(carol.address)).totalEarned - earnedBefore.carol) /
      PUBLISHER_SHARE;

    console.log(
      `        lottery wins over ${N} draws — earliest(alice)=${aliceWins} mid(bob)=${bobWins} latest(carol)=${carolWins}`,
    );

    // Every draw paid exactly one matured winner.
    expect(aliceWins + bobWins + carolWins).to.equal(BigInt(N));
    // Geometric weights 4:2:1 → earliest dominates the latest, and the ordering
    // earliest > mid > latest should hold over a large sample.
    expect(aliceWins).to.be.greaterThan(carolWins);
    expect(aliceWins).to.be.greaterThan(bobWins);
    expect(bobWins).to.be.greaterThan(carolWins);
    await assertConservation(env, accounts);
  });
});
