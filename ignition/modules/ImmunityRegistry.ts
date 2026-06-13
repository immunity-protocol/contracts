import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/// Deploys the ImmunityRegistry against an existing USDC token, wiring the pass-1
/// dependency stubs (registrar / reputation / protected set). The sibling
/// contracts replace these by address later via `setDependencies`.
///
/// `challengeManager` is passed as a parameter (the deployer EOA in pass 1, so a
/// testnet demo can drive challenges); set it to the real ChallengeManager later.
/// `deploy.sh` deploys MockUSDC first and writes its address into the params file.
export default buildModule("ImmunityRegistry", (m) => {
  const usdc = m.getParameter("usdc");
  const challengeManager = m.getParameter("challengeManager");

  const registrar = m.contract("StubPublisherRegistrar");
  const reputation = m.contract("StubReputation");
  const protectedSet = m.contract("StubProtectedSet");

  const registry = m.contract("ImmunityRegistry", [
    usdc,
    registrar,
    reputation,
    protectedSet,
    challengeManager,
  ]);

  return { registry, registrar, reputation, protectedSet };
});
