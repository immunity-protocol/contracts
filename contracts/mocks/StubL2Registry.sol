// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IL2Registry} from "../interfaces/IL2Registry.sol";

/// @title StubL2Registry
/// @notice Test/pass-1 stand-in for the Durin L2Registry. Models the bits the
///         PublisherRegistrar relies on: subname minting to an explicit owner,
///         per-node text records, and **text-write authorization** (node owner OR
///         approved registrar) — so the "a publisher cannot forge their own
///         immunity.* text" assertion is genuinely enforced. Replaced by the real
///         Durin L2Registry at deploy (#9).
contract StubL2Registry is IL2Registry {
    mapping(bytes32 => address) public override owner;       // node → owner
    mapping(address => bool) public registrars;             // approved registrars
    mapping(bytes32 => mapping(string => string)) internal _text;

    /// @dev Durin derives the node from the parent + label; mirror that here so
    ///      tests can recompute a node independently.
    function makeNode(bytes32 parentNode, string calldata label) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(parentNode, keccak256(bytes(label))));
    }

    function addRegistrar(address registrar) external {
        registrars[registrar] = true;
    }

    /// @inheritdoc IL2Registry
    function createSubnode(
        bytes32 parentNode,
        string calldata label,
        address _owner,
        bytes[] calldata /* data */
    ) external override returns (bytes32 node) {
        node = makeNode(parentNode, label);
        require(owner[node] == address(0), "label taken"); // uniqueness, like Durin
        owner[node] = _owner;
    }

    /// @inheritdoc IL2Registry
    /// @dev Auth mirrors Durin: only the node owner or an approved registrar writes.
    function setText(bytes32 node, string calldata key, string calldata value) external override {
        require(msg.sender == owner[node] || registrars[msg.sender], "not authorised");
        _text[node][key] = value;
    }

    /// @inheritdoc IL2Registry
    function text(bytes32 node, string calldata key) external view override returns (string memory) {
        return _text[node][key];
    }
}
