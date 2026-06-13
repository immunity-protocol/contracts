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

// ---- Lifecycle / state machine ----
/// @notice The antibody is not in a state this transition allows.
error InvalidStatusTransition();
/// @notice `expire` called before `expiresAt`, or `mature` conditions unmet.
error NotYet();
/// @notice Operation forbidden while a challenge is open.
error Challenged();
