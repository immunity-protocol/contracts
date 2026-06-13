// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// @title IReceiver — Chainlink CRE / Keystone report sink.
/// @notice Minimal vendored interface (the Chainlink keystone receiver type is not
///         published as an on-chain npm dependency; this mirrors the proven
///         poc-cre-attester pattern). The KeystoneForwarder calls `onReport` with
///         the workflow `metadata` and the signed `report` payload. Implementers
///         MUST gate on `msg.sender == forwarder` AND the pinned workflow id/owner.
interface IReceiver is IERC165 {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}
