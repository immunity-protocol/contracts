// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Strings.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IPublisherRegistrar} from "./interfaces/IPublisherRegistrar.sol";
import {IL2Registry} from "./interfaces/IL2Registry.sol";
import {Reputation} from "./Reputation.sol";
import {ZeroAddress, ZeroAmount, NotRegistered, AlreadyRegistered} from "./libraries/Errors.sol";

/// @title PublisherRegistrar — Immunity's publisher identity layer on Base.
/// @notice A Durin L2Registrar that (a) mints a CONTRACT-OWNED `*.immunity.eth`
///         subname per publisher, (b) locks a USDC registration bond, (c) answers
///         the ImmunityRegistry's `isRegistered` gate, and (d) mirrors the
///         canonical reputation into ENS text records (display-only).
///
///         The subname is minted to `address(this)` (the protocol), never the
///         publisher — for two B-5-shaped reasons: (1) only this registrar can
///         write the `immunity.*` text records, so the ENS reputation mirror is
///         un-forgeable; (2) a slashed publisher can't transfer the name to a
///         fresh wallet to escape its history. The publisher *is* the name but
///         doesn't custody the NFT.
///
///         The bond is a capital sybil speed-bump (lock-and-return), NOT the main
///         sybil defense — corroboration sybil-resistance lives in the reputation
///         floor + earned reputation + per-antibody bonds. The ENS mirror is
///         display-only and may be stale; the canonical reputation is the
///         Reputation contract (SDK/Registry read that, never ENS).
contract PublisherRegistrar is IPublisherRegistrar, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using Strings for uint256;

    struct Registration {
        bytes32 node;
        uint256 bond;
        bool    active;
        uint64  registeredAt;
    }

    mapping(address => Registration) internal _reg;        // publisher → registration
    mapping(bytes32 => address) public publisherOf;        // node → publisher

    IL2Registry public l2registry;                         // Durin registry (owner-set; stubbed in tests)
    Reputation  public reputation;                         // READ-ONLY (needs getPublisher, not on IReputation)
    IERC20      public immutable usdc;                     // registration bond token

    bytes32 public parentNode;                             // immunity.eth node (owner-set)
    uint256 public registrationBond = 10_000_000;          // 10 USDC default; owner-tunable (not dust)

    event Registered(address indexed publisher, bytes32 indexed node, string label, uint256 bond);
    event Deregistered(address indexed publisher, uint256 bondReturned);
    event ReputationSynced(address indexed publisher, bytes32 indexed node, uint256 score, uint64 strikes);
    event L2RegistrySet(address l2registry);
    event ReputationSet(address reputation);
    event ParentNodeSet(bytes32 parentNode);
    event RegistrationBondSet(uint256 amount);

    constructor(address _usdc) Ownable(msg.sender) {
        if (_usdc == address(0)) revert ZeroAddress();
        usdc = IERC20(_usdc);
    }

    // ------------------------------------------------------------------
    //  Identity gate (interface-required, exact)
    // ------------------------------------------------------------------

    /// @inheritdoc IPublisherRegistrar
    function isRegistered(address account) external view returns (bool) {
        return _reg[account].active;
    }

    // ------------------------------------------------------------------
    //  Register / deregister
    // ------------------------------------------------------------------

    /// @notice Register as a publisher: lock the bond and mint a contract-owned
    ///         `<label>.immunity.eth` subname. Required before `publish`.
    /// @dev Label uniqueness is enforced by the L2Registry (its revert surfaces).
    function registerPublisher(string calldata label) external nonReentrant {
        if (_reg[msg.sender].active) revert AlreadyRegistered();
        if (address(l2registry) == address(0)) revert ZeroAddress();

        usdc.safeTransferFrom(msg.sender, address(this), registrationBond);

        // Mint to address(this) — the protocol owns the name, not the publisher.
        bytes32 node = l2registry.createSubnode(parentNode, label, address(this), new bytes[](0));

        _reg[msg.sender] = Registration({
            node: node,
            bond: registrationBond,
            active: true,
            registeredAt: uint64(block.timestamp)
        });
        publisherOf[node] = msg.sender;

        emit Registered(msg.sender, node, label, registrationBond);
    }

    /// @notice Deregister and reclaim the bond. The subname stays contract-owned
    ///         and dormant (not burned). Existing antibodies are unaffected — the
    ///         Registry only checks `isRegistered` at publish time, so this just
    ///         stops *new* publishes.
    function deregister() external nonReentrant {
        Registration storage r = _reg[msg.sender];
        if (!r.active) revert NotRegistered();

        uint256 bond = r.bond;
        r.active = false;
        r.bond = 0;

        usdc.safeTransfer(msg.sender, bond);
        emit Deregistered(msg.sender, bond);
    }

    // ------------------------------------------------------------------
    //  Reputation mirror (display-only, permissionless poke)
    // ------------------------------------------------------------------

    /// @notice Refresh the publisher's `immunity.*` ENS text from the canonical
    ///         Reputation contract. Permissionless — anyone can poke. This NEVER
    ///         writes the Reputation score (registrar is read-only there); the
    ///         mirror is display-only and may be stale, never a trust input.
    function syncReputation(address publisher) external {
        Registration storage r = _reg[publisher];
        if (r.node == bytes32(0)) revert NotRegistered();
        if (address(reputation) == address(0)) revert ZeroAddress();

        uint256 score = reputation.scoreOf(publisher);
        uint64 strikes = reputation.getPublisher(publisher).slashedCount;

        l2registry.setText(r.node, "immunity.reputation", score.toString());
        l2registry.setText(r.node, "immunity.strikes", uint256(strikes).toString());

        emit ReputationSynced(publisher, r.node, score, strikes);
    }

    // ------------------------------------------------------------------
    //  Owner config
    // ------------------------------------------------------------------

    function setL2Registry(address _l2registry) external onlyOwner {
        if (_l2registry == address(0)) revert ZeroAddress();
        l2registry = IL2Registry(_l2registry);
        emit L2RegistrySet(_l2registry);
    }

    function setReputation(address _reputation) external onlyOwner {
        if (_reputation == address(0)) revert ZeroAddress();
        reputation = Reputation(_reputation);
        emit ReputationSet(_reputation);
    }

    function setParentNode(bytes32 _parentNode) external onlyOwner {
        parentNode = _parentNode;
        emit ParentNodeSet(_parentNode);
    }

    function setRegistrationBond(uint256 amount) external onlyOwner {
        if (amount == 0) revert ZeroAmount();
        registrationBond = amount;
        emit RegistrationBondSet(amount);
    }

    // ------------------------------------------------------------------
    //  Views
    // ------------------------------------------------------------------

    function nodeOf(address publisher) external view returns (bytes32) {
        return _reg[publisher].node;
    }

    function getRegistration(address publisher) external view returns (Registration memory) {
        return _reg[publisher];
    }
}
