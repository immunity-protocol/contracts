// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IReceiver} from "./interfaces/IReceiver.sol";
import {
    ZeroAddress,
    ZeroCheckId,
    NotForwarder,
    InvalidWorkflowId,
    InvalidWorkflowOwner,
    DuplicateCheck,
    UnknownCheck
} from "./libraries/Errors.sol";

/// @title NovelVerification — Tier-3 per-check CRE verification entrypoint + verdict sink.
/// @notice The on-chain trigger for per-check LLM threat detection (Path B, on-chain
///         trigger, DON-signed). When an agent's `check()` cache-misses on a novel
///         action, the SDK uploads encrypted evidence to the gateway, then calls
///         `requestVerification` here (own wallet, pays `checkFee`). That emits
///         `VerificationRequested`, which the Chainlink CRE workflow log-triggers on.
///         The workflow evaluates the action in the TEE and writes a DON-signed verdict
///         back through the KeystoneForwarder → `onReport` → the SDK awaits it.
///
///         This is the per-check analogue of `CREVerdictReceiver` (the challenge jury's
///         sink); it is purely additive and does NOT touch the core Registry — there is
///         no core redeploy and no re-seed.
///
///         B-2 hardening: `onReport` pins BOTH `msg.sender == forwarder` AND the decoded
///         workflow id/owner, and rejects any report for a checkId that is not currently
///         `pending`. A consumer that checks only the sender (or neither) is spoofable.
///         A pinned value of zero disables that particular check (set real pins at deploy).
contract NovelVerification is IReceiver, Ownable {
    using SafeERC20 for IERC20;

    /// @notice Fee token (USDC, 6 decimals on Base; MockUSDC on testnet).
    IERC20 public immutable usdc;
    /// @notice Fee destination — funds CRE compute.
    address public immutable treasury;
    /// @notice Fee pulled per verification request (USDC, 6 decimals). Owner-tunable
    ///         via `setCheckFee` — model/CRE costs change, so retune without redeploy.
    uint256 public checkFee;
    /// @notice Canonical KeystoneForwarder for this chain (CRE delivers through it).
    address public immutable forwarder;
    /// @notice Pinned CRE workflow id; bytes32(0) = don't check.
    bytes32 public immutable expectedWorkflowId;
    /// @notice Pinned CRE workflow owner; address(0) = don't check.
    address public immutable expectedWorkflowOwner;

    /// @notice Per-check verdict severity classes. Wired as `uint8` in the report.
    /// @dev BENIGN=0, SUSPICIOUS=1, MALICIOUS=2. NOTE: this is the locked on-chain
    ///      ordering for the per-check sink and differs from the SDK's publish-side
    ///      `VerdictValue` (MALICIOUS=0, SUSPICIOUS=1), which never emits BENIGN.
    enum Verdict { BENIGN, SUSPICIOUS, MALICIOUS }

    /// @notice The DON-signed verdict for a check.
    /// @param verdict    Verdict enum value (0/1/2).
    /// @param confidence Model confidence, 0–100.
    /// @param severity   Threat severity, 0–100.
    /// @param at         Block timestamp the verdict was recorded.
    struct Result {
        uint8 verdict;
        uint16 confidence;
        uint8 severity;
        uint64 at;
    }

    /// @notice Recorded verdict per checkId (set once on the first valid report).
    mapping(bytes32 => Result) public verdictOf;
    /// @notice checkId requested but not yet answered (replay/dup + unsolicited guard).
    mapping(bytes32 => bool) public pending;

    /// @param checkId     Caller-chosen unique id binding this request to its evidence.
    /// @param requester   The agent wallet that paid the fee.
    /// @param evidenceCid  Content id of the encrypted evidence uploaded to the gateway.
    /// @param contextHash Hash binding the request to its evaluation context.
    event VerificationRequested(
        bytes32 indexed checkId,
        address indexed requester,
        bytes32 evidenceCid,
        bytes32 contextHash
    );
    /// @param checkId    The request this verdict answers.
    /// @param verdict    Verdict enum value (0/1/2).
    /// @param confidence Model confidence, 0–100.
    /// @param severity   Threat severity, 0–100.
    event Verified(bytes32 indexed checkId, uint8 verdict, uint16 confidence, uint8 severity);
    /// @param checkFee The new per-request fee (USDC, 6 decimals).
    event CheckFeeUpdated(uint256 checkFee);

    /// @param _usdc                 Fee token (USDC / MockUSDC).
    /// @param _treasury             Fee destination (funds CRE compute).
    /// @param _checkFee             Fee per request (may be 0 for a free tier).
    /// @param _forwarder            KeystoneForwarder for this chain.
    /// @param _expectedWorkflowId    B-2 pin; bytes32(0) = don't check.
    /// @param _expectedWorkflowOwner B-2 pin; address(0) = don't check.
    constructor(
        address _usdc,
        address _treasury,
        uint256 _checkFee,
        address _forwarder,
        bytes32 _expectedWorkflowId,
        address _expectedWorkflowOwner
    ) Ownable(msg.sender) {
        if (_usdc == address(0)) revert ZeroAddress();
        if (_treasury == address(0)) revert ZeroAddress();
        if (_forwarder == address(0)) revert ZeroAddress();
        usdc = IERC20(_usdc);
        treasury = _treasury;
        checkFee = _checkFee;
        forwarder = _forwarder;
        expectedWorkflowId = _expectedWorkflowId;
        expectedWorkflowOwner = _expectedWorkflowOwner;
    }

    /// @notice Update the per-request fee (owner only) — retune to model/CRE cost
    ///         without redeploying. Takes effect on the next `requestVerification`.
    /// @param _checkFee The new fee (USDC, 6 decimals); 0 = free tier.
    function setCheckFee(uint256 _checkFee) external onlyOwner {
        checkFee = _checkFee;
        emit CheckFeeUpdated(_checkFee);
    }

    /// @notice Request a Tier-3 per-check verification — the on-chain CRE trigger.
    /// @dev Pulls `checkFee` USDC from the caller to the treasury (SafeERC20), marks
    ///      the checkId `pending`, and emits the log the CRE workflow triggers on.
    ///      Rejects a zero checkId and any checkId already pending or already answered
    ///      (no duplicate / replay).
    /// @param checkId     Caller-chosen unique id binding this request to its evidence.
    /// @param evidenceCid Content id of the encrypted evidence uploaded to the gateway.
    /// @param contextHash Hash binding the request to its evaluation context.
    function requestVerification(bytes32 checkId, bytes32 evidenceCid, bytes32 contextHash)
        external
    {
        if (checkId == bytes32(0)) revert ZeroCheckId();
        if (pending[checkId] || verdictOf[checkId].at != 0) revert DuplicateCheck();

        pending[checkId] = true;

        if (checkFee != 0) {
            usdc.safeTransferFrom(msg.sender, treasury, checkFee);
        }

        emit VerificationRequested(checkId, msg.sender, evidenceCid, contextHash);
    }

    /// @inheritdoc IReceiver
    /// @dev report = abi.encode(bytes32 checkId, uint8 verdict, uint16 confidence, uint8 severity).
    ///      Spoof-safe: forwarder check + B-2 workflow pins + `pending` guard. A report
    ///      for an unknown or already-answered checkId reverts.
    function onReport(bytes calldata metadata, bytes calldata report) external override {
        if (msg.sender != forwarder) revert NotForwarder();

        (bytes32 workflowId, , address workflowOwner) = _decodeMetadata(metadata);
        if (expectedWorkflowId != bytes32(0) && workflowId != expectedWorkflowId) {
            revert InvalidWorkflowId();
        }
        if (expectedWorkflowOwner != address(0) && workflowOwner != expectedWorkflowOwner) {
            revert InvalidWorkflowOwner();
        }

        (bytes32 checkId, uint8 verdict, uint16 confidence, uint8 severity) =
            abi.decode(report, (bytes32, uint8, uint16, uint8));

        if (!pending[checkId]) revert UnknownCheck();

        verdictOf[checkId] = Result(verdict, confidence, severity, uint64(block.timestamp));
        delete pending[checkId];

        emit Verified(checkId, verdict, confidence, severity);
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
