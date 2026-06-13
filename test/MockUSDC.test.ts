import { expect } from "chai";
import { getEthers } from "./utils.js";

describe("MockUSDC", function () {
  let ethers: any;
  let usdc: any;
  let alice: any;
  let bob: any;

  beforeEach(async function () {
    ethers = await getEthers();
    [alice, bob] = await ethers.getSigners();
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    usdc = await MockUSDC.deploy();
    await usdc.waitForDeployment();
  });

  it("has the expected name and symbol", async function () {
    expect(await usdc.name()).to.equal("Mock USDC");
    expect(await usdc.symbol()).to.equal("USDC");
  });

  it("uses 6 decimals", async function () {
    expect(await usdc.decimals()).to.equal(6);
  });

  it("mints to the recipient", async function () {
    await usdc.mint(alice.address, 1_000_000n);
    expect(await usdc.balanceOf(alice.address)).to.equal(1_000_000n);
  });

  it("transfers like a standard ERC20", async function () {
    await usdc.mint(alice.address, 1_000_000n);
    await usdc.connect(alice).transfer(bob.address, 400_000n);
    expect(await usdc.balanceOf(alice.address)).to.equal(600_000n);
    expect(await usdc.balanceOf(bob.address)).to.equal(400_000n);
  });
});
