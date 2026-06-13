// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IProtectedSet — curated blue-chip safety rail.
/// @notice A timelock/multisig-curated list of objectively-legit addresses
///         (USDC, WETH, canonical routers, major Base protocols). The Registry
///         reads it for bond scaling only: flagging a protected target costs a
///         large multiplier. The advisory-max enforcement cap (read-side) and the
///         auto-open-challenge (ChallengeManager) live elsewhere, not here.
interface IProtectedSet {
    /// @return true iff `target` is on the curated protected list.
    function isProtected(address target) external view returns (bool);
}
