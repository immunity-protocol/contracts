// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";

import {IVerifierPool} from "./interfaces/IVerifierPool.sol";
import {IChallengeManager} from "./interfaces/IChallengeManager.sol";
import {ZeroAddress, NotChallengeManagerCaller} from "./libraries/Errors.sol";

/// @title VerifierPool — Layer-2 staked-juror backstop (pass-1 stub).
/// @notice The ChallengeManager escalates here when Layer-1 (the diverse-model CRE
///         jury) reaches no strong consensus, so thin/ambiguous evidence never
///         auto-punishes an honest early-warner. This is the decentralized
///         Schelling backstop — no multisig, no single human.
///
///         ── PASS-1 (this contract): interface + thin stub + the manager seam ──
///         `escalate` records the dispute and emits `Escalated`; there is no
///         staking or voting yet, so resolution falls through to the manager's
///         `resolveTimeout` (conservative default: uphold, no slash). `stubResolve`
///         lets the owner drive the Layer-2 → manager seam so the wiring is real
///         and testable.
///
///         ── PASS-2 (documented design, to fill in): ──
///         - verifier-agents stake USDC to join the pool;
///         - `escalate(antibodyId)` opens a commit-reveal vote (commit
///           `keccak256(vote, salt)`, then reveal) over `voteWindow`/`revealWindow`;
///         - `finalize` tallies revealed votes → majority verdict →
///           `submitLayer2Verdict(antibodyId, invalid)`;
///         - **slash the incoherent (minority) voters' stakes** and pay the juror
///           fee + redistributed slashed stakes to the **coherent** voters only
///           (paying everyone regardless kills the incentive to vote correctly);
///         - owner sets stake size, quorum, vote/reveal windows, slash %.
contract VerifierPool is IVerifierPool, Ownable {
    /// @notice The ChallengeManager — the only caller of `escalate` and the target
    ///         of `submitLayer2Verdict` (set by owner; circular deploy → setter).
    IChallengeManager public challengeManager;

    /// @notice Escalations seen (telemetry; pass-2 will hold the live vote state).
    mapping(bytes32 => uint64) public escalatedAt;

    event ChallengeManagerSet(address challengeManager);
    event Escalated(bytes32 indexed antibodyId, uint64 at);

    constructor() Ownable(msg.sender) {}

    modifier onlyChallengeManager() {
        if (msg.sender != address(challengeManager)) revert NotChallengeManagerCaller();
        _;
    }

    function setChallengeManager(address _challengeManager) external onlyOwner {
        if (_challengeManager == address(0)) revert ZeroAddress();
        challengeManager = IChallengeManager(_challengeManager);
        emit ChallengeManagerSet(_challengeManager);
    }

    /// @inheritdoc IVerifierPool
    /// @dev Pass-1: park the escalation. No vote runs; the manager's
    ///      `resolveTimeout` settles conservatively once `layer2Timeout` elapses.
    function escalate(bytes32 antibodyId) external override onlyChallengeManager {
        escalatedAt[antibodyId] = uint64(block.timestamp);
        emit Escalated(antibodyId, uint64(block.timestamp));
    }

    /// @notice Pass-1 manager-seam exercise: the owner forwards a Layer-2 verdict
    ///         to the manager. In pass-2 `finalize` (driven by the commit-reveal
    ///         tally) calls `submitLayer2Verdict` instead of this owner stub.
    function stubResolve(bytes32 antibodyId, bool invalid) external onlyOwner {
        challengeManager.submitLayer2Verdict(antibodyId, invalid);
    }
}
