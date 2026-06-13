import { expect } from "chai";
import { getEthers } from "./utils.js";

// Default points (mirror the contract constructor).
const MATURE = 10n;
const CHALLENGE_WON = 20n;
const SLASH = 1000n;

describe("Reputation", function () {
  let ethers: any;
  let owner: any, writer: any, pub: any, stranger: any;
  let reputation: any;

  beforeEach(async function () {
    ethers = await getEthers();
    [owner, writer, pub, stranger] = await ethers.getSigners();
    reputation = await (await ethers.getContractFactory("Reputation")).deploy();
    await reputation.waitForDeployment();
    // Authorize `writer` as the stand-in protocol writer.
    await reputation.setAuthorizedWriter(writer.address, true);
  });

  it("starts every publisher at score 0", async function () {
    expect(await reputation.scoreOf(pub.address)).to.equal(0n);
  });

  it("defaults to slow-build / fast-loss points (slashPenalty ≫ maturePoints)", async function () {
    expect(await reputation.maturePoints()).to.equal(MATURE);
    expect(await reputation.challengeWonPoints()).to.equal(CHALLENGE_WON);
    expect(await reputation.slashPenalty()).to.equal(SLASH);
    expect(await reputation.slashPenalty()).to.be.greaterThan(await reputation.maturePoints());
  });

  describe("authorized-writer gating", function () {
    it("reverts onMatured / onChallengeWon / onSlash for a non-writer EOA", async function () {
      await expect(
        reputation.connect(stranger).onMatured(pub.address),
      ).to.be.revertedWithCustomError(reputation, "NotAuthorizedWriter");
      await expect(
        reputation.connect(stranger).onChallengeWon(pub.address),
      ).to.be.revertedWithCustomError(reputation, "NotAuthorizedWriter");
      await expect(
        reputation.connect(stranger).onSlash(pub.address),
      ).to.be.revertedWithCustomError(reputation, "NotAuthorizedWriter");
    });

    it("reverts even for the publisher grading themselves", async function () {
      await expect(
        reputation.connect(pub).onMatured(pub.address),
      ).to.be.revertedWithCustomError(reputation, "NotAuthorizedWriter");
    });

    it("lets the owner authorize and revoke writers", async function () {
      await reputation.setAuthorizedWriter(stranger.address, true);
      await reputation.connect(stranger).onMatured(pub.address); // now allowed
      await reputation.setAuthorizedWriter(stranger.address, false);
      await expect(
        reputation.connect(stranger).onMatured(pub.address),
      ).to.be.revertedWithCustomError(reputation, "NotAuthorizedWriter");
    });

    it("only the owner can manage writers / points", async function () {
      await expect(
        reputation.connect(stranger).setAuthorizedWriter(stranger.address, true),
      ).to.be.revertedWithCustomError(reputation, "OwnableUnauthorizedAccount");
      await expect(
        reputation.connect(stranger).setPoints(1n, 1n, 1n),
      ).to.be.revertedWithCustomError(reputation, "OwnableUnauthorizedAccount");
    });
  });

  describe("earning and losing score", function () {
    it("raises score and counter on matured", async function () {
      await expect(reputation.connect(writer).onMatured(pub.address))
        .to.emit(reputation, "Matured")
        .withArgs(pub.address, MATURE);
      expect(await reputation.scoreOf(pub.address)).to.equal(MATURE);
      expect((await reputation.getPublisher(pub.address)).maturedCount).to.equal(1n);
    });

    it("raises score and counter on challenge won", async function () {
      await expect(reputation.connect(writer).onChallengeWon(pub.address))
        .to.emit(reputation, "ChallengeWon")
        .withArgs(pub.address, CHALLENGE_WON);
      expect(await reputation.scoreOf(pub.address)).to.equal(CHALLENGE_WON);
      expect((await reputation.getPublisher(pub.address)).challengesWon).to.equal(1n);
    });

    it("one slash wipes many matures (slashPenalty ≫ maturePoints)", async function () {
      // 50 matures = 500 < slashPenalty 1000 → one slash floors to 0
      for (let i = 0; i < 50; i++) await reputation.connect(writer).onMatured(pub.address);
      expect(await reputation.scoreOf(pub.address)).to.equal(MATURE * 50n);

      await expect(reputation.connect(writer).onSlash(pub.address))
        .to.emit(reputation, "Slashed")
        .withArgs(pub.address, 0n);
      expect(await reputation.scoreOf(pub.address)).to.equal(0n);
      expect((await reputation.getPublisher(pub.address)).slashedCount).to.equal(1n);
    });

    it("floors at 0 and never underflows", async function () {
      await reputation.connect(writer).onMatured(pub.address); // score 10
      await reputation.connect(writer).onSlash(pub.address); // 10 - 1000 → 0
      expect(await reputation.scoreOf(pub.address)).to.equal(0n);
      // a second slash on a zero score stays 0
      await reputation.connect(writer).onSlash(pub.address);
      expect(await reputation.scoreOf(pub.address)).to.equal(0n);
    });

    it("subtracts exactly when score exceeds the penalty", async function () {
      await reputation.setPoints(600n, 20n, 1000n);
      await reputation.connect(writer).onMatured(pub.address); // 600
      await reputation.connect(writer).onMatured(pub.address); // 1200
      await reputation.connect(writer).onSlash(pub.address); // 1200 - 1000 = 200
      expect(await reputation.scoreOf(pub.address)).to.equal(200n);
    });
  });

  describe("genesis bootstrap", function () {
    it("owner can grant genesis reputation; tracked + event emitted", async function () {
      await expect(reputation.grantGenesisReputation(pub.address, 100n))
        .to.emit(reputation, "GenesisGranted")
        .withArgs(pub.address, 100n, 100n);
      expect(await reputation.scoreOf(pub.address)).to.equal(100n);
      expect((await reputation.getPublisher(pub.address)).genesisGranted).to.equal(100n);
    });

    it("is owner-only and rejects the zero address", async function () {
      await expect(
        reputation.connect(stranger).grantGenesisReputation(pub.address, 100n),
      ).to.be.revertedWithCustomError(reputation, "OwnableUnauthorizedAccount");
      await expect(
        reputation.grantGenesisReputation(ethers.ZeroAddress, 100n),
      ).to.be.revertedWithCustomError(reputation, "ZeroAddress");
    });
  });
});
