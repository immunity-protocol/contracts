import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/// Standalone deploy of the Base-side subname registry (our own "durin").
///
/// The core suite (ImmunityCore) shipped with `StubL2Registry` as a placeholder;
/// this module deploys the production `ImmunityL2Registry`, after which
/// `scripts/ens/wire-base.ts` authorizes the live PublisherRegistrar on it and
/// repoints the registrar via `setL2Registry` — no registrar redeploy (the
/// IL2Registry ABI is preserved).
///
/// `admin` defaults to deployer account 0 (the protocol owner that also owns the
/// registrar); it manages the registrar allowlist. Base Sepolia only — no mainnet.
export default buildModule("ImmunityL2Registry", (m) => {
  const admin = m.getParameter("admin", m.getAccount(0));
  const l2registry = m.contract("ImmunityL2Registry", [admin]);
  return { l2registry };
});
