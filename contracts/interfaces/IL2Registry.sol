// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IL2Registry — minimal subset of the Durin L2Registry used by the
///        PublisherRegistrar to mint contract-owned ENS subnames on Base.
/// @notice This is a deliberately small interface over the real Durin
///         `L2Registry` (resolverworks/durin). At deploy (#9) we bind to the real
///         contract and add this registrar via `addRegistrar`; for tests we use
///         `StubL2Registry`. Confirm these signatures against the deployed Durin
///         when wiring — `createSubnode` returns the node and text records live in
///         the inherited resolver, keyed by `bytes32 node`.
interface IL2Registry {
    /// @notice Mint `<label>.<parent>` owned by `owner`, applying any resolver
    ///         setter calldata in `data` atomically. Authorized to the parent
    ///         node owner or an approved registrar. Returns the new node.
    function createSubnode(
        bytes32 parentNode,
        string calldata label,
        address owner,
        bytes[] calldata data
    ) external returns (bytes32 node);

    /// @notice Write a text record on `node`. Authorized to the node owner or an
    ///         approved registrar (so a contract-owned node is registrar-only).
    function setText(bytes32 node, string calldata key, string calldata value) external;

    /// @notice Read a text record on `node`.
    function text(bytes32 node, string calldata key) external view returns (string memory);

    /// @notice Owner of `node` (the NFT holder). For our subnames this is the
    ///         PublisherRegistrar contract itself (contract-owned identity).
    function owner(bytes32 node) external view returns (address);
}
