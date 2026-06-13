// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";

import {IReceiver} from "./interfaces/IReceiver.sol";
import {IChallengeManager} from "./interfaces/IChallengeManager.sol";
import {ZeroAddress, NotForwarder, InvalidWorkflowId, InvalidWorkflowOwner} from "./libraries/Errors.sol";

/// @title CREVerdictReceiver — Layer-1 Chainlink CRE verdict sink.
/// @notice Receives the diverse-model jury verdict from the CRE workflow via the
///         KeystoneForwarder and forwards the per-model tally to the
///         ChallengeManager. Mirrors the proven poc-cre-attester pattern.
///
///         B-2 hardening: `onReport` pins BOTH `msg.sender == forwarder` AND the
///         decoded workflow id/owner. A consumer that checks only the sender (or
///         neither) is spoofable — an attacker could forge a verdict. A pinned
///         value of zero disables that particular check (set real pins at deploy).
contract CREVerdictReceiver is IReceiver, Ownable {
    /// @notice Canonical KeystoneForwarder for this chain (CRE delivers through it).
    address public immutable forwarder;
    /// @notice Pinned CRE workflow id; 0 = don't check.
    bytes32 public immutable expectedWorkflowId;
    /// @notice Pinned CRE workflow owner; address(0) = don't check.
    address public immutable expectedWorkflowOwner;

    /// @notice The manager the decoded tally is forwarded to (set by owner; the
    ///         manager is deployed alongside this contract — circular, hence a setter).
    IChallengeManager public challengeManager;

    /// @notice Last verdict seen per antibody (telemetry / explorer).
    struct Verdict { uint16 invalidVotes; uint16 validVotes; uint64 at; }
    mapping(bytes32 => Verdict) public verdictOf;

    event ChallengeManagerSet(address challengeManager);
    event VerdictReceived(bytes32 indexed antibodyId, uint16 invalidVotes, uint16 validVotes);

    constructor(
        address _forwarder,
        bytes32 _expectedWorkflowId,
        address _expectedWorkflowOwner
    ) Ownable(msg.sender) {
        if (_forwarder == address(0)) revert ZeroAddress();
        forwarder = _forwarder;
        expectedWorkflowId = _expectedWorkflowId;
        expectedWorkflowOwner = _expectedWorkflowOwner;
    }

    function setChallengeManager(address _challengeManager) external onlyOwner {
        if (_challengeManager == address(0)) revert ZeroAddress();
        challengeManager = IChallengeManager(_challengeManager);
        emit ChallengeManagerSet(_challengeManager);
    }

    /// @inheritdoc IReceiver
    /// @dev report = abi.encode(bytes32 antibodyId, uint16 invalidVotes, uint16 validVotes).
    function onReport(bytes calldata metadata, bytes calldata report) external override {
        if (msg.sender != forwarder) revert NotForwarder();

        (bytes32 workflowId, , address workflowOwner) = _decodeMetadata(metadata);
        if (expectedWorkflowId != bytes32(0) && workflowId != expectedWorkflowId) {
            revert InvalidWorkflowId();
        }
        if (expectedWorkflowOwner != address(0) && workflowOwner != expectedWorkflowOwner) {
            revert InvalidWorkflowOwner();
        }

        (bytes32 antibodyId, uint16 invalidVotes, uint16 validVotes) =
            abi.decode(report, (bytes32, uint16, uint16));

        verdictOf[antibodyId] = Verdict(invalidVotes, validVotes, uint64(block.timestamp));
        emit VerdictReceived(antibodyId, invalidVotes, validVotes);

        challengeManager.submitLayer1Verdict(antibodyId, invalidVotes, validVotes);
    }

    /// @notice ERC-165 — advertises support for the CRE receiver interface.
    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return interfaceId == type(IReceiver).interfaceId
            || interfaceId == 0x01ffc9a7; // ERC-165
    }

    /// @dev Keystone metadata layout (abi.encodePacked):
    ///      bytes32 workflowId | bytes10 workflowName | address workflowOwner | …
    function _decodeMetadata(bytes calldata metadata)
        internal
        pure
        returns (bytes32 workflowId, bytes10 workflowName, address workflowOwner)
    {
        assembly {
            workflowId := calldataload(metadata.offset)
            workflowName := calldataload(add(metadata.offset, 32))
            workflowOwner := shr(96, calldataload(add(metadata.offset, 42)))
        }
    }
}
