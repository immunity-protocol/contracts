import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/// Standalone deploy of the L1 (Sepolia) signed off-chain ENS resolver.
///
/// This is the EIP-3668 CCIP-Read + ENSIP-10 wildcard resolver that makes
/// `*.<parent>.eth` resolve in any ENS app by deferring to OUR gateway, which
/// reads the record from the Base Sepolia `ImmunityL2Registry` and signs it.
///
/// PURELY ADDITIVE: deploys ONLY `ImmunityL1Resolver`. Sepolia-only (the L2
/// records live on Base Sepolia; this L1 resolver is what ENS apps query).
///
/// Parameters (override per environment):
///   - gatewayUrls   string[] of EIP-3668 gateway endpoints. Use the
///                   `{sender}`/`{data}` template form for GET, or a bare URL for
///                   POST. Default points at the fly.io service; for local
///                   end-to-end proof, override to the local gateway.
///   - trustedSigner the address whose key the gateway signs responses with.
///                   The resolver pins only this ADDRESS; the key is a gateway
///                   secret (env SIGNER_PRIVATE_KEY). MUST be set per deploy —
///                   the zero default is a deliberate tripwire.
export default buildModule("ImmunityL1Resolver", (m) => {
  const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

  const gatewayUrls = m.getParameter("gatewayUrls", [
    "https://immunity-ccip-gateway.fly.dev/{sender}/{data}.json",
  ]);
  // Must be overridden with the gateway's signer address before a real deploy.
  const trustedSigner = m.getParameter("trustedSigner", ZERO_ADDR);

  const resolver = m.contract("ImmunityL1Resolver", [gatewayUrls, trustedSigner]);

  return { resolver };
});
