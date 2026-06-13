import { expect } from "chai";
import {
  setupRegistryFixture,
  fund,
  registerPublisher,
  makeParams,
  STATUS,
  PUBLISHER_SHARE,
} from "./utils.js";

describe("ImmunityRegistry — challenge hooks", function () {
  let env: any;
  let id: string;

  beforeEach(async function () {
    env = await setupRegistryFixture();
    const { registry, ethers, alice } = env;
    await fund(registry, env.usdc, alice, 100_000_000n);
    await registerPublisher(env.registrar, env.reputation, alice);
    const params = makeParams(ethers);
    [id] = await registry.connect(alice).publish.staticCall(params);
    await registry.connect(alice).publish(params);
  });

  it("gates onChallengeOpened / onChallengeResolved to the ChallengeManager", async function () {
    const { registry, alice, challenger } = env;
    await expect(registry.connect(alice).onChallengeOpened(id)).to.be.revertedWithCustomError(
      registry,
      "NotChallengeManager",
    );
    await expect(
      registry.connect(alice).onChallengeResolved(id, true, challenger.address),
    ).to.be.revertedWithCustomError(registry, "NotChallengeManager");
  });

  it("opening a challenge moves the antibody to CHALLENGED", async function () {
    const { registry, challengeManager } = env;
    await expect(registry.connect(challengeManager).onChallengeOpened(id))
      .to.emit(registry, "ChallengeOpened");
    expect((await registry.getAntibody(id)).status).to.equal(STATUS.CHALLENGED);
  });

  it("escrows (not pays) a matched fee while CHALLENGED", async function () {
    const { registry, ethers, challengeManager, bob } = env;
    await registry.connect(challengeManager).onChallengeOpened(id);
    await fund(registry, env.usdc, bob, 10_000_000n);
    await registry.connect(bob).check(id, ethers.ZeroAddress, 0, 0);
    expect((await registry.getAntibody(id)).escrowedFees).to.equal(PUBLISHER_SHARE);
  });

  it("invalid verdict slashes: forfeits bond + escrow to the manager, signals onSlash, clears matcher", async function () {
    const { registry, ethers, alice, bob, challengeManager, challenger } = env;
    // accrue escrow, then challenge
    await fund(registry, env.usdc, bob, 10_000_000n);
    await registry.connect(bob).check(id, ethers.ZeroAddress, 0, 0);
    const ab0 = await registry.getAntibody(id);
    await registry.connect(challengeManager).onChallengeOpened(id);

    const mgrBefore = await registry.balances(challengeManager.address);
    await expect(
      registry.connect(challengeManager).onChallengeResolved(id, true, challenger.address),
    )
      .to.emit(registry, "Slashed")
      .withArgs(id, alice.address, challenger.address, ab0.bondAmount, PUBLISHER_SHARE);

    const ab = await registry.getAntibody(id);
    expect(ab.status).to.equal(STATUS.SLASHED);
    expect(ab.bondAmount).to.equal(0n);
    expect(ab.escrowedFees).to.equal(0n);

    // forfeited bond + escrow routed to the manager's balance (it splits downstream)
    expect(await registry.balances(challengeManager.address)).to.equal(
      mgrBefore + ab0.bondAmount + PUBLISHER_SHARE,
    );
    expect(await registry.totalBondsLocked()).to.equal(0n);
    expect(await registry.totalEscrowed()).to.equal(0n);
    expect(await env.reputation.slashCalls(alice.address)).to.equal(1n);
    expect((await registry.getAntibodiesByMatcher(ab0.primaryMatcherHash)).length).to.equal(0);
  });

  it("valid verdict upholds: restores prior tier and signals onChallengeWon", async function () {
    const { registry, alice, challengeManager, challenger } = env;
    await registry.connect(challengeManager).onChallengeOpened(id);
    await expect(
      registry.connect(challengeManager).onChallengeResolved(id, false, challenger.address),
    ).to.emit(registry, "ChallengeUpheld");
    // never matured → restored to PROBATION; bond intact
    const ab = await registry.getAntibody(id);
    expect(ab.status).to.equal(STATUS.PROBATION);
    expect(ab.bondAmount).to.be.greaterThan(0n);
    expect(await env.reputation.challengeWonCalls(alice.address)).to.equal(1n);
  });
});
