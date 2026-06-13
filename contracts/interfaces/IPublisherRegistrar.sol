// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IPublisherRegistrar — publisher identity gate.
/// @notice The real implementation (a Durin L2Registrar) mints a contract-owned
///         `*.immunity.eth` subname, locks a registration bond, and inits
///         reputation. The Registry only needs the boolean gate: publishing
///         requires a registered publisher. Checkers stay anonymous.
interface IPublisherRegistrar {
    /// @return true iff `account` has completed bonded publisher registration.
    function isRegistered(address account) external view returns (bool);
}
