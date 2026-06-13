import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/// Standalone deploy of the Tier-3 per-check verification contract.
///
/// PURELY ADDITIVE: this module deploys ONLY `NovelVerification`. It does not
/// touch the already-deployed Immunity core (no Registry redeploy, no re-seed).
///
/// Defaults are wired to the LIVE Base Sepolia core (chain 84532):
///   - usdc      = the deployed MockUSDC (6 decimals)
///   - treasury  = the deployer EOA (the core has no separate treasury address;
///                 the Registry holds fees internally as `treasuryBalance`, so for
///                 this external-treasury sink we default to the deployer — override
///                 `treasury` to point fees at a dedicated CRE-compute wallet)
///   - checkFee  = 2000 (0.002 USDC at 6 decimals — matches the Registry CHECK_FEE)
///   - forwarder = the deployer EOA placeholder, zero workflow pins, so the E2E can
///                 drive simulated DON-signed verdicts. Real KeystoneForwarder +
///                 pinned workflow id/owner => redeploy (the pins are immutable).
export default buildModule("NovelVerification", (m) => {
  const deployer = m.getAccount(0);
  const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
  const ZERO_HASH =
    "0x0000000000000000000000000000000000000000000000000000000000000000";

  const usdc = m.getParameter(
    "usdc",
    "0xe697EF7724453F239D8c0EB9295D87C344D9CE60", // live Base Sepolia MockUSDC
  );
  const treasury = m.getParameter("treasury", deployer);
  const checkFee = m.getParameter("checkFee", 2_000n); // 0.002 USDC (6 decimals)
  const forwarder = m.getParameter("forwarder", deployer); // simulation placeholder
  const expectedWorkflowId = m.getParameter("expectedWorkflowId", ZERO_HASH);
  const expectedWorkflowOwner = m.getParameter("expectedWorkflowOwner", ZERO_ADDR);

  const novelVerification = m.contract("NovelVerification", [
    usdc,
    treasury,
    checkFee,
    forwarder,
    expectedWorkflowId,
    expectedWorkflowOwner,
  ]);

  return { novelVerification };
});
