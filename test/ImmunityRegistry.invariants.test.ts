import { expect } from "chai";
import {
  setupRegistryFixture,
  fund,
  registerPublisher,
  makeParams,
  increaseTime,
} from "./utils.js";

// USDC the contract holds must always equal the sum of every claim against it:
//   Σ prepaid balances + treasury + Σ locked bonds + Σ escrowed fees.
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

describe("ImmunityRegistry — economic invariants", function () {
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

  it("conserves USDC across publish / check / mature / expire", async function () {
    const { registry, ethers, alice, bob, carol, dave } = env;
    const matcher = ethers.id("threat");

    for (const s of [alice, bob, carol]) {
      await fund(registry, env.usdc, s, 100_000_000n);
      await registerPublisher(env.registrar, env.reputation, s);
      await registry.connect(s).publish(makeParams(ethers, { primaryMatcherHash: matcher }));
      await assertConservation(env, accounts);
    }

    const aliceId = await registry.computeKeccakId(0, 0, matcher, alice.address);
    await fund(registry, env.usdc, dave, 10_000_000n);
    await registry.connect(dave).check(aliceId, ethers.ZeroAddress, 0, 0);
    await assertConservation(env, accounts);

    await registry.mature(aliceId);
    await assertConservation(env, accounts);

    await registry.connect(dave).check(aliceId, ethers.ZeroAddress, 0, 0); // direct pay now
    await assertConservation(env, accounts);
  });

  it("a bond is released XOR forfeited — never both (slash path)", async function () {
    const { registry, ethers, alice, bob, challengeManager, challenger } = env;
    await fund(registry, env.usdc, alice, 100_000_000n);
    await registerPublisher(env.registrar, env.reputation, alice);
    const params = makeParams(ethers);
    const [id] = await registry.connect(alice).publish.staticCall(params);
    await registry.connect(alice).publish(params);

    await registry.connect(challengeManager).onChallengeOpened(id);
    await registry.connect(challengeManager).onChallengeResolved(id, true, challenger.address);
    await assertConservation(env, accounts);

    // bond is gone from the publisher and locked totals; cannot also be released
    expect(await registry.totalBondsLocked()).to.equal(0n);
    await expect(registry.expire(id)).to.be.revertedWithCustomError(
      registry,
      "InvalidStatusTransition",
    );
  });

  it("escrow is released XOR clawed back — never both", async function () {
    const { registry, ethers, alice, bob } = env;
    await fund(registry, env.usdc, alice, 100_000_000n);
    await registerPublisher(env.registrar, env.reputation, alice);
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    const params = makeParams(ethers, { expiresAt: now + 3600 });
    const [id] = await registry.connect(alice).publish.staticCall(params);
    await registry.connect(alice).publish(params);

    await fund(registry, env.usdc, bob, 10_000_000n);
    await registry.connect(bob).check(id, ethers.ZeroAddress, 0, 0);
    expect(await registry.totalEscrowed()).to.be.greaterThan(0n);

    // never matured → escrow clawed to treasury on expiry
    await increaseTime(ethers, 3601);
    await registry.expire(id);
    expect(await registry.totalEscrowed()).to.equal(0n);
    await assertConservation(env, accounts);
  });
});
