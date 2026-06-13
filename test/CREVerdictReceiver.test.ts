import { expect } from "chai";
import { getEthers } from "./utils.js";

const WORKFLOW_ID = "0x" + "11".repeat(32);
const WORKFLOW_NAME = "0x" + "aa".repeat(10); // bytes10
const ANTIBODY = "0x" + "cd".repeat(32);

// metadata = abi.encodePacked(bytes32 workflowId, bytes10 workflowName, address workflowOwner)
function makeMetadata(ethers: any, id: string, owner: string) {
  return ethers.solidityPacked(["bytes32", "bytes10", "address"], [id, WORKFLOW_NAME, owner]);
}
function makeReport(ethers: any, antibodyId: string, invalid: number, valid: number) {
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "uint16", "uint16"],
    [antibodyId, invalid, valid],
  );
}

describe("CREVerdictReceiver", function () {
  let ethers: any;
  let owner: any, forwarder: any, workflowOwner: any, stranger: any;
  let receiver: any, mock: any;

  beforeEach(async function () {
    ethers = await getEthers();
    [owner, forwarder, workflowOwner, stranger] = await ethers.getSigners();

    mock = await (await ethers.getContractFactory("MockChallengeManager")).deploy();
    await mock.waitForDeployment();

    receiver = await (await ethers.getContractFactory("CREVerdictReceiver")).deploy(
      forwarder.address,
      WORKFLOW_ID,
      workflowOwner.address,
    );
    await receiver.waitForDeployment();
    await receiver.setChallengeManager(await mock.getAddress());
  });

  it("reverts when the caller is not the pinned forwarder", async function () {
    const md = makeMetadata(ethers, WORKFLOW_ID, workflowOwner.address);
    const rp = makeReport(ethers, ANTIBODY, 3, 0);
    await expect(
      receiver.connect(stranger).onReport(md, rp),
    ).to.be.revertedWithCustomError(receiver, "NotForwarder");
  });

  it("reverts on a spoofed workflow id", async function () {
    const md = makeMetadata(ethers, "0x" + "99".repeat(32), workflowOwner.address);
    const rp = makeReport(ethers, ANTIBODY, 3, 0);
    await expect(
      receiver.connect(forwarder).onReport(md, rp),
    ).to.be.revertedWithCustomError(receiver, "InvalidWorkflowId");
  });

  it("reverts on a spoofed workflow owner", async function () {
    const md = makeMetadata(ethers, WORKFLOW_ID, stranger.address);
    const rp = makeReport(ethers, ANTIBODY, 3, 0);
    await expect(
      receiver.connect(forwarder).onReport(md, rp),
    ).to.be.revertedWithCustomError(receiver, "InvalidWorkflowOwner");
  });

  it("decodes the tally and forwards to the manager on a valid report", async function () {
    const md = makeMetadata(ethers, WORKFLOW_ID, workflowOwner.address);
    const rp = makeReport(ethers, ANTIBODY, 3, 1);
    await expect(receiver.connect(forwarder).onReport(md, rp))
      .to.emit(receiver, "VerdictReceived")
      .withArgs(ANTIBODY, 3, 1);

    expect(await mock.layer1Calls()).to.equal(1n);
    expect(await mock.lastAntibodyId()).to.equal(ANTIBODY);
    expect(await mock.lastInvalidVotes()).to.equal(3);
    expect(await mock.lastValidVotes()).to.equal(1);
  });

  it("advertises the IReceiver interface via ERC-165", async function () {
    // type(IReceiver).interfaceId excludes inherited functions → just onReport.selector
    const ifaceId = ethers.id("onReport(bytes,bytes)").slice(0, 10);
    expect(await receiver.supportsInterface(ifaceId)).to.equal(true);
    expect(await receiver.supportsInterface("0x01ffc9a7")).to.equal(true); // ERC-165
    expect(await receiver.supportsInterface("0xffffffff")).to.equal(false);
  });
});
