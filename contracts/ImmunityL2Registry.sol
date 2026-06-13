// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IL2Registry} from "./interfaces/IL2Registry.sol";
import {
    ZeroAddress,
    NotAdmin,
    NotApprovedRegistrar,
    NotAuthorizedWriter,
    LabelTaken
} from "./libraries/Errors.sol";

/// @title ImmunityL2Registry
/// @notice The Base-side subname registry the PublisherRegistrar mints into. It
///         is our own minimal "durin" L2Registry: contract-owned subnames under
///         `immunity.eth` plus registrar-gated text records, so the protocol's
///         B-5 guarantees hold on Base regardless of how third-party ENS apps
///         resolve the name.
///
///         - Anti-flight: subnames are owned by the PublisherRegistrar contract,
///           not the publisher EOA — a publisher cannot transfer or burn their
///           identity to dodge reputation.
///         - Un-forgeable mirror: only the node owner or an approved registrar
///           writes `immunity.*` text, so a publisher cannot forge their own
///           reputation record.
///
///         Conforms exactly to {IL2Registry} so the live PublisherRegistrar can
///         switch to this via `setL2Registry(this)` with no redeploy. Node owner
///         is tracked as an `owner(bytes32)` mapping (not ERC-721) — this is a
///         display/identity mirror; canonical reputation is the on-chain
///         Reputation contract.
contract ImmunityL2Registry is IL2Registry {
    /// @notice node → owner. For protocol subnames this is the registrar contract.
    mapping(bytes32 => address) public override owner;
    /// @notice Approved registrars allowed to mint subnodes and write text.
    mapping(address => bool) public registrars;
    /// @notice Protocol owner; manages the registrar allowlist. Not OZ Ownable —
    ///         `Ownable.owner()` would collide with `owner(bytes32)` above.
    address public admin;

    mapping(bytes32 => mapping(string => string)) internal _text;

    event SubnodeCreated(bytes32 indexed node, bytes32 indexed parentNode, string label, address owner);
    event TextChanged(bytes32 indexed node, string key, string value);
    event RegistrarSet(address indexed registrar, bool approved);
    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    constructor(address admin_) {
        if (admin_ == address(0)) revert ZeroAddress();
        admin = admin_;
        emit AdminTransferred(address(0), admin_);
    }

    /// @notice Approve or revoke a registrar (e.g. the PublisherRegistrar).
    function setRegistrar(address registrar, bool approved) external onlyAdmin {
        if (registrar == address(0)) revert ZeroAddress();
        registrars[registrar] = approved;
        emit RegistrarSet(registrar, approved);
    }

    /// @notice Approve a registrar. Kept for parity with the Durin `addRegistrar`
    ///         shape the wiring script expects.
    function addRegistrar(address registrar) external onlyAdmin {
        if (registrar == address(0)) revert ZeroAddress();
        registrars[registrar] = true;
        emit RegistrarSet(registrar, true);
    }

    /// @notice Hand the admin role to a new account.
    function transferAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert ZeroAddress();
        emit AdminTransferred(admin, newAdmin);
        admin = newAdmin;
    }

    /// @dev Node derivation mirrors ENS/Durin: `keccak256(parentNode, keccak256(label))`.
    function makeNode(bytes32 parentNode, string calldata label) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(parentNode, keccak256(bytes(label))));
    }

    /// @inheritdoc IL2Registry
    /// @dev Restricted to approved registrars (or the admin). `data` is accepted
    ///      for ABI parity with Durin but unused — text is written separately via
    ///      `setText`, keeping this a minimal identity registry.
    function createSubnode(
        bytes32 parentNode,
        string calldata label,
        address _owner,
        bytes[] calldata /* data */
    ) external override returns (bytes32 node) {
        if (!registrars[msg.sender] && msg.sender != admin) revert NotApprovedRegistrar();
        node = makeNode(parentNode, label);
        if (owner[node] != address(0)) revert LabelTaken();
        owner[node] = _owner;
        emit SubnodeCreated(node, parentNode, label, _owner);
    }

    /// @inheritdoc IL2Registry
    /// @dev Only the node owner or an approved registrar writes — so a
    ///      contract-owned node is registrar-only (un-forgeable mirror).
    function setText(bytes32 node, string calldata key, string calldata value) external override {
        if (msg.sender != owner[node] && !registrars[msg.sender]) revert NotAuthorizedWriter();
        _text[node][key] = value;
        emit TextChanged(node, key, value);
    }

    /// @inheritdoc IL2Registry
    function text(bytes32 node, string calldata key) external view override returns (string memory) {
        return _text[node][key];
    }
}
