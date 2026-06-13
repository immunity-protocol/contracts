import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/// Standalone MockUSDC deploy. Used on Base Sepolia when not pointing at the
/// canonical Circle USDC. `deploy.sh` runs this first and feeds the resulting
/// address into the Registry module's `usdc` parameter.
export default buildModule("MockUSDC", (m) => {
  const usdc = m.contract("MockUSDC");
  return { usdc };
});
