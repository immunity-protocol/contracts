import { expect } from "chai";
import { setupChallengeFixture, makeParams, STATUS, increaseTime } from "./utils.js";

const MIN_CHALLENGE_BOND = 5_000_000n;
const LAYER_TIMEOUT = 3600;

// An un-adjudicated timeout (the CRE/jury simply didn't answer) must credit NO
// reputation — otherwise an actor could self-publish + self-challenge + await a
// timeout to farm reputation at zero permanent cost (publish bond reclaimable via
// retire, challenge bond refunded on timeout).
describe("Challenge timeout — credits no reputation (farming vector closed)", function () {
  let env: any;
  let id: string;

  async function publish(label: string) {
    const { registry, ethers, alice } = env;
    const p = makeParams(ethers, { primaryMatcherHash: ethers.id(label) });
    const [pid] = await registry.connect(alice).publish.staticCall(p);
    await registry.connect(alice).publish(p);
    return pid;
  }

  beforeEach(async function () {
    env = await setupChallengeFixture();
    id = await publish("threat");
  });

  it("Layer-1 timeout: publisher reputation unchanged, antibody restored, bond refunded", async function () {
    const { manager, registry, reputation, usdc, ethers, alice, challenger } = env;
    await manager.connect(challenger).challenge(id);

    const scoreBefore = await reputation.scoreOf(alice.address);
    const wonBefore = (await reputation.getPublisher(alice.address)).challengesWon;
    const refundBefore = await usdc.balanceOf(challenger.address);

    await increaseTime(ethers, LAYER_TIMEOUT + 1);
    await expect(manager.resolveTimeout(id)).to.emit(registry, "ChallengeTimedOut");

    // NO reputation credit for an un-adjudicated timeout
    expect(await reputation.scoreOf(alice.address)).to.equal(scoreBefore);
    expect((await reputation.getPublisher(alice.address)).challengesWon).to.equal(wonBefore);
    // antibody restored, challenger fully refunded
    expect((await registry.getAntibody(id)).status).to.equal(STATUS.PROBATION);
    expect(await usdc.balanceOf(challenger.address)).to.equal(refundBefore + MIN_CHALLENGE_BOND);
  });

  it("Layer-2 timeout: publisher reputation still unchanged after escalation", async function () {
    const { manager, registry, reputation, usdc, ethers, alice, bob, challenger } = env;
    await manager.connect(challenger).challenge(id);
    await manager.setCreReceiver(bob.address);
    await manager.connect(bob).submitLayer1Verdict(id, 1, 1); // no supermajority → escalate

    const scoreBefore = await reputation.scoreOf(alice.address);
    const wonBefore = (await reputation.getPublisher(alice.address)).challengesWon;
    const refundBefore = await usdc.balanceOf(challenger.address);

    await increaseTime(ethers, LAYER_TIMEOUT + 1);
    await expect(manager.resolveTimeout(id)).to.emit(registry, "ChallengeTimedOut");

    expect(await reputation.scoreOf(alice.address)).to.equal(scoreBefore);
    expect((await reputation.getPublisher(alice.address)).challengesWon).to.equal(wonBefore);
    expect((await registry.getAntibody(id)).status).to.equal(STATUS.PROBATION);
    expect(await usdc.balanceOf(challenger.address)).to.equal(refundBefore + MIN_CHALLENGE_BOND);
  });

  it("contrast: an adjudicated VALID verdict DOES credit reputation", async function () {
    const { manager, reputation, alice, bob, challenger } = env;
    await manager.connect(challenger).challenge(id);
    await manager.setCreReceiver(bob.address);

    const wonBefore = (await reputation.getPublisher(alice.address)).challengesWon;
    await manager.connect(bob).submitLayer1Verdict(id, 0, 3); // strong VALID → real win
    expect((await reputation.getPublisher(alice.address)).challengesWon).to.equal(wonBefore + 1n);
  });
});
