import { expect } from "chai";
import { getEthers } from "./utils.js";

const WORKFLOW_ID = "0x" + "11".repeat(32);
const WORKFLOW_NAME = "0x" + "aa".repeat(10); // bytes10
const CHECK_ID = "0x" + "cd".repeat(32);
const EVIDENCE_CID = "0x" + "ab".repeat(32);
const CONTEXT_HASH = "0x" + "ef".repeat(32);

const CHECK_FEE = 2_000n; // 0.002 USDC (6 decimals) — matches Registry CHECK_FEE

// metadata = abi.encodePacked(bytes32 workflowId, bytes10 workflowName, address workflowOwner)
function makeMetadata(ethers: any, id: string, owner: string) {
  return ethers.solidityPacked(["bytes32", "bytes10", "address"], [id, WORKFLOW_NAME, owner]);
}
// report = abi.encode(bytes32 checkId, uint8 verdict, uint16 confidence, uint8 severity)
function makeReport(
  ethers: any,
  checkId: string,
  verdict: number,
  confidence: number,
  severity: number,
) {
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "uint8", "uint16", "uint8"],
    [checkId, verdict, confidence, severity],
  );
}

describe("NovelVerification", function () {
  let ethers: any;
  let owner: any, treasury: any, forwarder: any, workflowOwner: any, agent: any, stranger: any;
  let usdc: any, nv: any;

  // Deploy with pins DISABLED (zero) so onReport can be driven from `forwarder`.
  async function deploy(pins = false) {
    usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    await usdc.waitForDeployment();
    nv = await (await ethers.getContractFactory("NovelVerification")).deploy(
      await usdc.getAddress(),
      treasury.address,
      CHECK_FEE,
      forwarder.address,
      pins ? WORKFLOW_ID : ethers.ZeroHash,
      pins ? workflowOwner.address : ethers.ZeroAddress,
    );
    await nv.waitForDeployment();
  }

  // Mint USDC to the agent and approve the contract to pull the fee.
  async function fundAgent(amount: bigint, approve: bigint) {
    await usdc.mint(agent.address, amount);
    await usdc.connect(agent).approve(await nv.getAddress(), approve);
  }

  beforeEach(async function () {
    ethers = await getEthers();
    [owner, treasury, forwarder, workflowOwner, agent, stranger] = await ethers.getSigners();
    await deploy(false);
  });

  describe("constructor", function () {
    it("reverts on zero usdc", async function () {
      const NV = await ethers.getContractFactory("NovelVerification");
      await expect(
        NV.deploy(ethers.ZeroAddress, treasury.address, CHECK_FEE, forwarder.address, ethers.ZeroHash, ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(NV, "ZeroAddress");
    });

    it("reverts on zero treasury", async function () {
      const NV = await ethers.getContractFactory("NovelVerification");
      await expect(
        NV.deploy(await usdc.getAddress(), ethers.ZeroAddress, CHECK_FEE, forwarder.address, ethers.ZeroHash, ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(NV, "ZeroAddress");
    });

    it("reverts on zero forwarder", async function () {
      const NV = await ethers.getContractFactory("NovelVerification");
      await expect(
        NV.deploy(await usdc.getAddress(), treasury.address, CHECK_FEE, ethers.ZeroAddress, ethers.ZeroHash, ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(NV, "ZeroAddress");
    });

    it("stores the constructor params", async function () {
      expect(await nv.usdc()).to.equal(await usdc.getAddress());
      expect(await nv.treasury()).to.equal(treasury.address);
      expect(await nv.checkFee()).to.equal(CHECK_FEE);
      expect(await nv.forwarder()).to.equal(forwarder.address);
      expect(await nv.expectedWorkflowId()).to.equal(ethers.ZeroHash);
      expect(await nv.expectedWorkflowOwner()).to.equal(ethers.ZeroAddress);
    });
  });

  describe("requestVerification", function () {
    beforeEach(async function () {
      await fundAgent(CHECK_FEE * 10n, CHECK_FEE * 10n);
    });

    it("pulls exactly checkFee to the treasury, emits, and marks pending", async function () {
      await expect(nv.connect(agent).requestVerification(CHECK_ID, EVIDENCE_CID, CONTEXT_HASH))
        .to.emit(nv, "VerificationRequested")
        .withArgs(CHECK_ID, agent.address, EVIDENCE_CID, CONTEXT_HASH);

      expect(await usdc.balanceOf(treasury.address)).to.equal(CHECK_FEE);
      expect(await usdc.balanceOf(agent.address)).to.equal(CHECK_FEE * 10n - CHECK_FEE);
      expect(await nv.pending(CHECK_ID)).to.equal(true);
    });

    it("reverts on a zero checkId", async function () {
      await expect(
        nv.connect(agent).requestVerification(ethers.ZeroHash, EVIDENCE_CID, CONTEXT_HASH),
      ).to.be.revertedWithCustomError(nv, "ZeroCheckId");
    });

    it("reverts on a duplicate checkId that is still pending", async function () {
      await nv.connect(agent).requestVerification(CHECK_ID, EVIDENCE_CID, CONTEXT_HASH);
      await expect(
        nv.connect(agent).requestVerification(CHECK_ID, EVIDENCE_CID, CONTEXT_HASH),
      ).to.be.revertedWithCustomError(nv, "DuplicateCheck");
    });

    it("reverts on a checkId already answered (replay)", async function () {
      await nv.connect(agent).requestVerification(CHECK_ID, EVIDENCE_CID, CONTEXT_HASH);
      const md = makeMetadata(ethers, WORKFLOW_ID, workflowOwner.address);
      const rp = makeReport(ethers, CHECK_ID, 2, 95, 80);
      await nv.connect(forwarder).onReport(md, rp);
      await expect(
        nv.connect(agent).requestVerification(CHECK_ID, EVIDENCE_CID, CONTEXT_HASH),
      ).to.be.revertedWithCustomError(nv, "DuplicateCheck");
    });

    it("reverts on insufficient allowance", async function () {
      await usdc.connect(agent).approve(await nv.getAddress(), CHECK_FEE - 1n);
      await expect(
        nv.connect(agent).requestVerification(CHECK_ID, EVIDENCE_CID, CONTEXT_HASH),
      ).to.be.revertedWithCustomError(usdc, "ERC20InsufficientAllowance");
    });

    it("reverts on insufficient balance", async function () {
      const poor = stranger;
      await usdc.connect(poor).approve(await nv.getAddress(), CHECK_FEE);
      await expect(
        nv.connect(poor).requestVerification(CHECK_ID, EVIDENCE_CID, CONTEXT_HASH),
      ).to.be.revertedWithCustomError(usdc, "ERC20InsufficientBalance");
    });
  });

  describe("onReport", function () {
    beforeEach(async function () {
      await fundAgent(CHECK_FEE * 10n, CHECK_FEE * 10n);
      await nv.connect(agent).requestVerification(CHECK_ID, EVIDENCE_CID, CONTEXT_HASH);
    });

    it("reverts when the caller is not the forwarder", async function () {
      const md = makeMetadata(ethers, WORKFLOW_ID, workflowOwner.address);
      const rp = makeReport(ethers, CHECK_ID, 2, 95, 80);
      await expect(
        nv.connect(stranger).onReport(md, rp),
      ).to.be.revertedWithCustomError(nv, "NotForwarder");
    });

    it("reverts on a report for a non-pending checkId", async function () {
      const unknown = "0x" + "99".repeat(32);
      const md = makeMetadata(ethers, WORKFLOW_ID, workflowOwner.address);
      const rp = makeReport(ethers, unknown, 2, 95, 80);
      await expect(
        nv.connect(forwarder).onReport(md, rp),
      ).to.be.revertedWithCustomError(nv, "UnknownCheck");
    });

    it("stores the verdict, clears pending, and emits (pins disabled)", async function () {
      const md = makeMetadata(ethers, WORKFLOW_ID, workflowOwner.address);
      const rp = makeReport(ethers, CHECK_ID, 2, 95, 80);
      await expect(nv.connect(forwarder).onReport(md, rp))
        .to.emit(nv, "Verified")
        .withArgs(CHECK_ID, 2, 95, 80);

      const res = await nv.verdictOf(CHECK_ID);
      expect(res.verdict).to.equal(2);
      expect(res.confidence).to.equal(95);
      expect(res.severity).to.equal(80);
      expect(res[3] > 0n).to.equal(true); // at (timestamp)
      expect(await nv.pending(CHECK_ID)).to.equal(false);
    });
  });

  describe("onReport with workflow pins enforced", function () {
    beforeEach(async function () {
      await deploy(true); // pins = WORKFLOW_ID + workflowOwner
      await fundAgent(CHECK_FEE * 10n, CHECK_FEE * 10n);
      await nv.connect(agent).requestVerification(CHECK_ID, EVIDENCE_CID, CONTEXT_HASH);
    });

    it("reverts on a spoofed workflow id", async function () {
      const md = makeMetadata(ethers, "0x" + "99".repeat(32), workflowOwner.address);
      const rp = makeReport(ethers, CHECK_ID, 2, 95, 80);
      await expect(
        nv.connect(forwarder).onReport(md, rp),
      ).to.be.revertedWithCustomError(nv, "InvalidWorkflowId");
    });

    it("reverts on a spoofed workflow owner", async function () {
      const md = makeMetadata(ethers, WORKFLOW_ID, stranger.address);
      const rp = makeReport(ethers, CHECK_ID, 2, 95, 80);
      await expect(
        nv.connect(forwarder).onReport(md, rp),
      ).to.be.revertedWithCustomError(nv, "InvalidWorkflowOwner");
    });

    it("accepts a correctly-pinned report", async function () {
      const md = makeMetadata(ethers, WORKFLOW_ID, workflowOwner.address);
      const rp = makeReport(ethers, CHECK_ID, 1, 60, 40);
      await expect(nv.connect(forwarder).onReport(md, rp))
        .to.emit(nv, "Verified")
        .withArgs(CHECK_ID, 1, 60, 40);
    });
  });

  describe("supportsInterface", function () {
    it("advertises IReceiver and ERC-165, rejects others", async function () {
      const ifaceId = ethers.id("onReport(bytes,bytes)").slice(0, 10);
      expect(await nv.supportsInterface(ifaceId)).to.equal(true);
      expect(await nv.supportsInterface("0x01ffc9a7")).to.equal(true); // ERC-165
      expect(await nv.supportsInterface("0xffffffff")).to.equal(false);
    });
  });

  describe("full round-trip", function () {
    it("request → onReport → verdict readable", async function () {
      await fundAgent(CHECK_FEE, CHECK_FEE);
      await nv.connect(agent).requestVerification(CHECK_ID, EVIDENCE_CID, CONTEXT_HASH);
      expect(await nv.pending(CHECK_ID)).to.equal(true);

      const md = makeMetadata(ethers, WORKFLOW_ID, workflowOwner.address);
      const rp = makeReport(ethers, CHECK_ID, 0, 10, 0);
      await nv.connect(forwarder).onReport(md, rp);

      const res = await nv.verdictOf(CHECK_ID);
      expect(res.verdict).to.equal(0); // BENIGN
      expect(res.confidence).to.equal(10);
      expect(res.severity).to.equal(0);
      expect(await nv.pending(CHECK_ID)).to.equal(false);
    });
  });
});
