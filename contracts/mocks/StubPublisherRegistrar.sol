// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPublisherRegistrar} from "../interfaces/IPublisherRegistrar.sol";

/// @title StubPublisherRegistrar
/// @notice Test/pass-1 stand-in for the real Durin-backed registrar. Lets tests
///         (and a testnet bootstrap) flip registration on/off per address.
///         Replaced by the real PublisherRegistrar by address later.
contract StubPublisherRegistrar is IPublisherRegistrar {
    mapping(address => bool) private _registered;

    function setRegistered(address account, bool ok) external {
        _registered[account] = ok;
    }

    function isRegistered(address account) external view returns (bool) {
        return _registered[account];
    }
}
