import { expect } from "chai";
import { getEthers } from "./utils.js";

// The Registry keeps OpenZeppelin's ReentrancyGuard. MaliciousUSDC re-enters
// `withdraw` from inside its transfer hook; the guard must block it.
describe("ImmunityRegistry — reentrancy", function () {
  it("blocks reentrancy through the token transfer path on withdraw", async function () {
    const ethers = await getEthers();
    const [owner, alice] = await ethers.getSigners();

    const mal = await (await ethers.getContractFactory("MaliciousUSDC")).deploy();
    await mal.waitForDeployment();

    const Registry = await ethers.getContractFactory("ImmunityRegistry");
    const registry = await Registry.deploy(
      await mal.getAddress(),
      ethers.ZeroAddress,
      ethers.ZeroAddress,
      ethers.ZeroAddress,
      ethers.ZeroAddress,
    );
    await registry.waitForDeployment();

    await mal.setVictim(await registry.getAddress());
    await mal.mint(alice.address, 1_000_000n);
    await mal.connect(alice).approve(await registry.getAddress(), 1_000_000n);
    await registry.connect(alice).deposit(1_000_000n);

    // Arm the re-entrant transfer hook; the guard blocks the nested withdraw, so
    // the inner call fails and MaliciousUSDC surfaces REENTRY_BLOCKED.
    await mal.setAttacking(true);
    await expect(registry.connect(alice).withdraw(500_000n)).to.be.revertedWith(
      "REENTRY_BLOCKED",
    );
  });
});
