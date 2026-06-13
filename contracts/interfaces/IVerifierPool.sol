// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IVerifierPool — Layer-2 staked-juror backstop.
/// @notice The ChallengeManager escalates here when Layer-1 (CRE) reaches no strong
///         consensus. In pass 1 this is a thin stub (escalation parks; the manager
///         resolves conservatively on timeout); the full commit-reveal staked vote
///         is pass 2.
interface IVerifierPool {
    /// @notice Open a Layer-2 dispute for `antibodyId`. Caller must be the ChallengeManager.
    function escalate(bytes32 antibodyId) external;
}
