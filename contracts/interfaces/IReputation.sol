// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IReputation — on-chain publisher reputation.
/// @notice Reputation is a deterministic protocol output: it is written ONLY by
///         the protocol's Registry + ChallengeManager logic, never by the
///         publisher and never by CRE. The Registry must be an authorized writer.
///         The Registry reads `scoreOf` (e.g. for the corroboration rep-floor and
///         as a read-side enforcement input) and signals lifecycle events.
interface IReputation {
    /// @notice Current reputation score of `publisher`. Fresh identity = 0.
    function scoreOf(address publisher) external view returns (uint256);

    /// @notice An antibody by `publisher` matured (earned positive signal).
    /// @param weight The antibody's locked bond (USDC, 6dp) — reputation is credited
    ///        in proportion to skin-in-the-game so it can't be cheaply self-farmed.
    function onMatured(address publisher, uint256 weight) external;

    /// @notice An antibody by `publisher` was proven false and slashed.
    function onSlash(address publisher) external;

    /// @notice A challenge against `publisher`'s antibody was resolved in its favor.
    /// @param weight The antibody's locked bond (USDC, 6dp) — surviving a challenge is
    ///        the premium signal and is credited at a multiple of the bond.
    function onChallengeWon(address publisher, uint256 weight) external;
}
