// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @notice ENSIP-10 wildcard resolver entry point.
interface IExtendedResolver {
    function resolve(bytes memory name, bytes memory data) external view returns (bytes memory);
}

/// @notice The off-chain resolution service the gateway implements. The L1
///         resolver encodes a call to this selector into the `OffchainLookup`
///         calldata so the CCIP-Read client knows what to ask the gateway.
interface IResolverService {
    function resolve(bytes calldata name, bytes calldata data)
        external
        view
        returns (bytes memory result, uint64 expires, bytes memory sig);
}

/// @title ImmunityL1Resolver
/// @notice A signed off-chain ENS resolver (EIP-3668 CCIP-Read + ENSIP-10
///         wildcard) for `*.<parent>.eth`. It is a by-hand port of ENS's
///         offchain-resolver reference (OffchainResolver.sol):
///         every query reverts `OffchainLookup` pointing at our gateway, the
///         gateway reads the record from the Base Sepolia `ImmunityL2Registry`
///         and signs it, and `resolveWithProof` verifies the signature against a
///         pinned `trustedSigner` before returning the record.
///
///         Trust note (matches ENS's reference posture): the gateway signer is
///         trusted. Storage-proof trustlessness (Durin/Unruggable) is a later
///         upgrade. This contract pins only the signer ADDRESS — the signing key
///         lives off-chain in the gateway.
///
///         Signing scheme (identical to the ENS reference's SignatureVerifier):
///           keccak256(0x1900 ‖ resolverAddr ‖ uint64 expires
///                     ‖ keccak256(callData) ‖ keccak256(result))
///         where `callData` is the full `abi.encodeWithSelector(
///         IResolverService.resolve, name, data)` the client sent to the gateway.
contract ImmunityL1Resolver is IExtendedResolver, Ownable {
    /// @notice Gateway URLs the CCIP-Read client will try (EIP-3668 `urls`).
    string[] public gatewayUrls;
    /// @notice The single trusted off-chain signer the gateway signs responses
    ///         with. The resolver verifies recovered signer == this address.
    address public trustedSigner;

    /// @dev ENSIP-10 IExtendedResolver interface id.
    bytes4 private constant _IEXTENDED_RESOLVER_ID = 0x9061b923;
    /// @dev ERC-165 interface id.
    bytes4 private constant _ERC165_ID = 0x01ffc9a7;

    event GatewayUrlsSet(string[] urls);
    event TrustedSignerSet(address indexed signer);

    error OffchainLookup(
        address sender,
        string[] urls,
        bytes callData,
        bytes4 callbackFunction,
        bytes extraData
    );
    error InvalidSigner();
    error SignatureExpired();
    error EmptyGatewayUrls();
    error ZeroSigner();

    constructor(string[] memory _gatewayUrls, address _trustedSigner) Ownable(msg.sender) {
        _setGatewayUrls(_gatewayUrls);
        _setTrustedSigner(_trustedSigner);
    }

    // ------------------------------------------------------------------
    //  Owner config
    // ------------------------------------------------------------------

    function setGatewayUrls(string[] calldata _gatewayUrls) external onlyOwner {
        _setGatewayUrls(_gatewayUrls);
    }

    function setTrustedSigner(address _trustedSigner) external onlyOwner {
        _setTrustedSigner(_trustedSigner);
    }

    function _setGatewayUrls(string[] memory _gatewayUrls) internal {
        if (_gatewayUrls.length == 0) revert EmptyGatewayUrls();
        gatewayUrls = _gatewayUrls;
        emit GatewayUrlsSet(_gatewayUrls);
    }

    function _setTrustedSigner(address _trustedSigner) internal {
        if (_trustedSigner == address(0)) revert ZeroSigner();
        trustedSigner = _trustedSigner;
        emit TrustedSignerSet(_trustedSigner);
    }

    function gatewayUrlCount() external view returns (uint256) {
        return gatewayUrls.length;
    }

    // ------------------------------------------------------------------
    //  ENSIP-10 wildcard resolution (EIP-3668)
    // ------------------------------------------------------------------

    /// @inheritdoc IExtendedResolver
    /// @dev Always reverts `OffchainLookup` so a CCIP-Read-aware client fetches
    ///      the answer from the gateway and calls `resolveWithProof`.
    /// @param name The DNS-encoded name being resolved (full subname).
    /// @param data The inner resolution calldata (e.g. `text(bytes32,string)`).
    function resolve(bytes calldata name, bytes calldata data)
        external
        view
        override
        returns (bytes memory)
    {
        bytes memory callData = abi.encodeWithSelector(IResolverService.resolve.selector, name, data);
        revert OffchainLookup(
            address(this),
            gatewayUrls,
            callData,
            this.resolveWithProof.selector,
            abi.encode(callData)
        );
    }

    /// @notice CCIP-Read callback: verify the gateway's signature and return the
    ///         resolved record.
    /// @param response ABI-encoded `(bytes result, uint64 expires, bytes sig)`.
    /// @param extraData ABI-encoded `(bytes callData)` echoed from `resolve`.
    function resolveWithProof(bytes calldata response, bytes calldata extraData)
        external
        view
        returns (bytes memory)
    {
        (bytes memory result, uint64 expires, bytes memory sig) =
            abi.decode(response, (bytes, uint64, bytes));
        bytes memory callData = abi.decode(extraData, (bytes));

        if (expires < block.timestamp) revert SignatureExpired();

        bytes32 hash = makeSignatureHash(address(this), expires, callData, result);
        address signer = ECDSA.recover(hash, sig);
        if (signer != trustedSigner) revert InvalidSigner();

        return result;
    }

    /// @notice The exact message hash the gateway must sign. Exposed so the
    ///         gateway (and tests) can reproduce it verbatim.
    function makeSignatureHash(
        address target,
        uint64 expires,
        bytes memory callData,
        bytes memory result
    ) public pure returns (bytes32) {
        return keccak256(
            abi.encodePacked(hex"1900", target, expires, keccak256(callData), keccak256(result))
        );
    }

    // ------------------------------------------------------------------
    //  ERC-165
    // ------------------------------------------------------------------

    function supportsInterface(bytes4 interfaceID) external pure returns (bool) {
        return interfaceID == _IEXTENDED_RESOLVER_ID || interfaceID == _ERC165_ID;
    }
}
