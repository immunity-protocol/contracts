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
///   - checkFee  = 10000 (0.01 USDC at 6 decimals — covers Haiku + CRE + gas with
///                 margin; owner-tunable on-chain via setCheckFee, no redeploy)
///   - forwarder = the CRE Base Sepolia KeystoneForwarder (0x82300bd7…). `cre
///                 workflow simulate --broadcast` transmits the DON-signed report
///                 THROUGH this forwarder, so `onReport`'s onlyForwarder check must
///                 trust it — the forwarder is the report's msg.sender, not the
///                 broadcaster, so a deployer-EOA forwarder never accepts the write.
///                 Workflow id/owner pins left zero (forwarder-only auth); pinning
///                 them (B-2) is a hardening follow-up.
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
  const checkFee = m.getParameter("checkFee", 10_000n); // 0.01 USDC (6 decimals) — owner-tunable via setCheckFee
  // CRE Base Sepolia KeystoneForwarder — `simulate --broadcast` transmits through it.
  const forwarder = m.getParameter(
    "forwarder",
    "0x82300bd7c3958625581cc2F77bC6464dcEcDF3e5",
  );
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
