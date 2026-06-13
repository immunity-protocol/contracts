// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Custom errors emitted by the Immunity Registry. File-scope so that
///         contracts can `revert InsufficientBalance()` directly.

// ---- Balance / token ----
error InsufficientBalance();
error ZeroAddress();
error ZeroAmount();

// ---- Antibody identity / existence ----
error AntibodyExists();
error AntibodyNotFound();

// ---- Publish validation ----
error InvalidConfidence();
error InvalidSeverity();
error InvalidVerdict();
error InvalidAntibodyType();
/// @notice `publish` requires a finite TTL — `expiresAt` must be in the future.
error ExpiryRequired();

// ---- Access control ----
/// @notice `publish` is gated to a registered publisher (PublisherRegistrar).
error NotRegistered();
/// @notice `onChallengeOpened` / `onChallengeResolved` are ChallengeManager-only.
error NotChallengeManager();
/// @notice `retire` is restricted to the antibody's own publisher.
error NotPublisher();
/// @notice Reputation writes (onMatured/onChallengeWon/onSlash) are restricted to
///         authorized protocol writers (the Registry, later the ChallengeManager).
error NotAuthorizedWriter();
/// @notice `registerPublisher` called by an already-registered publisher.
error AlreadyRegistered();

// ---- Challenge game ----
/// @notice CRE `onReport` caller is not the pinned KeystoneForwarder.
error NotForwarder();
/// @notice CRE report's workflow id does not match the pinned value.
error InvalidWorkflowId();
/// @notice CRE report's workflow owner does not match the pinned value.
error InvalidWorkflowOwner();
/// @notice `submitLayer1Verdict` caller is not the CREVerdictReceiver.
error NotCreReceiver();
/// @notice `submitLayer2Verdict` caller is not the VerifierPool.
error NotVerifierPool();
/// @notice `escalate` caller is not the ChallengeManager.
error NotChallengeManagerCaller();
/// @notice A challenge is already open for this antibody.
error ChallengeAlreadyOpen();
/// @notice No active challenge in the required state for this antibody.
error NoActiveChallenge();
/// @notice Economics bps shares exceed 10_000.
error InvalidBps();

// ---- Lifecycle / state machine ----
/// @notice The antibody is not in a state this transition allows.
error InvalidStatusTransition();
/// @notice `expire` called before `expiresAt`, or `mature` conditions unmet.
error NotYet();
/// @notice Operation forbidden while a challenge is open.
error Challenged();

// ---- L2 subname registry (ENS on Base) ----
/// @notice Caller is not the registry admin (the deployer / protocol owner).
error NotAdmin();
/// @notice `createSubnode` caller is neither an approved registrar nor the admin.
error NotApprovedRegistrar();
/// @notice A subname node already exists for this parent + label.
error LabelTaken();
