import { expect } from "chai";
import { setupChallengeFixture, makeParams, STATUS, ZERO_BYTES32 } from "./utils.js";

// Drives the FULL stack through the real CREVerdictReceiver:
// forwarder → onReport → ChallengeManager → Registry slash/uphold.
describe("Challenge game integration (publish → CRE verdict → slash / uphold)", function () {
  let env: any;

  // Pins are disabled in the fixture, so metadata contents are irrelevant.
  function metadata(ethers: any) {
    return ethers.solidityPacked(
      ["bytes32", "bytes10", "address"],
      [ZERO_BYTES32, "0x" + "00".repeat(10), ethers.ZeroAddress],
    );
  }
  function report(ethers: any, id: string, invalid: number, valid: number) {
    return ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "uint16", "uint16"],
      [id, invalid, valid],
    );
  }

  async function publish(label: string) {
    const { registry, ethers, alice } = env;
    const p = makeParams(ethers, { primaryMatcherHash: ethers.id(label) });
    const [id] = await registry.connect(alice).publish.staticCall(p);
    await registry.connect(alice).publish(p);
    return id;
  }

  beforeEach(async function () {
    env = await setupChallengeFixture();
  });

  it("INVALID verdict → antibody SLASHED, matcher cleared, reputation slashed", async function () {
    const { ethers, registry, manager, reputation, receiver, forwarder, challenger, alice } = env;
    const id = await publish("bad");

    await expect(manager.connect(challenger).challenge(id)).to.emit(manager, "VerdictRequested");
    expect((await registry.getAntibody(id)).status).to.equal(STATUS.CHALLENGED);

    // CRE delivers a strong INVALID verdict through the forwarder.
    await expect(receiver.connect(forwarder).onReport(metadata(ethers), report(ethers, id, 3, 0)))
      .to.emit(manager, "Resolved");

    expect((await registry.getAntibody(id)).status).to.equal(STATUS.SLASHED);
    expect((await registry.getAntibodiesByMatcher(ethers.id("bad"))).length).to.equal(0);
    expect((await reputation.getPublisher(alice.address)).slashedCount).to.equal(1n);
  });

  it("VALID verdict → antibody upheld, challenge-won signalled", async function () {
    const { ethers, registry, manager, reputation, receiver, forwarder, challenger, alice } = env;
    const id = await publish("good");

    await manager.connect(challenger).challenge(id);
    await receiver.connect(forwarder).onReport(metadata(ethers), report(ethers, id, 0, 3));

    expect((await registry.getAntibody(id)).status).to.equal(STATUS.PROBATION); // restored
    expect((await reputation.getPublisher(alice.address)).challengesWon).to.equal(1n);
  });

  it("split verdict → escalates to Layer-2", async function () {
    const { ethers, manager, pool, receiver, forwarder, challenger } = env;
    const id = await publish("ambiguous");

    await manager.connect(challenger).challenge(id);
    await receiver.connect(forwarder).onReport(metadata(ethers), report(ethers, id, 1, 1));

    expect((await manager.getChallenge(id)).status).to.equal(2); // LAYER2_ESCALATED
    expect(await pool.escalatedAt(id)).to.be.greaterThan(0n);
  });
});
