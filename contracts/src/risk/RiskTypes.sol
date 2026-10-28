// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice A trader's reviewed risk class. `None` means never reviewed; it is also what a failed review reports,
/// and a failed review never changes a stored verdict.
enum Tier {
    None,
    Ok,
    Caution,
    Block
}

/// @notice The verdict the gate holds for one trader. `tier` and `reviewedAt` share the first slot, which is all
/// `allowIncrease` reads.
struct Verdict {
    Tier tier;
    uint64 reviewedAt;
    uint256 shannonRequestId;
    bytes32 summaryHash;
}

/// @notice Hyperlane message bodies between the gate (Hideki) and the reviewer (Shannon), and the hub's id for a
/// trader source.
library RiskMessages {
    /// @dev Gate to reviewer.
    function encodeRequest(address trader, uint64 nonce) internal pure returns (bytes memory) {
        return abi.encode(trader, nonce);
    }

    function decodeRequest(bytes calldata body) internal pure returns (address trader, uint64 nonce) {
        return abi.decode(body, (address, uint64));
    }

    /// @dev Reviewer to gate. `tier` 0 reports a failed review; `requestId` is the inference request the tier
    /// came from (on failure, the request that failed, or 0).
    function encodeVerdict(address trader, uint64 nonce, uint8 tier, uint256 requestId, bytes32 summaryHash)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(trader, nonce, tier, requestId, summaryHash);
    }

    function decodeVerdict(bytes calldata body)
        internal
        pure
        returns (address trader, uint64 nonce, uint8 tier, uint256 requestId, bytes32 summaryHash)
    {
        return abi.decode(body, (address, uint64, uint8, uint256, bytes32));
    }

    /// @dev The hub's id for a trader source: keccak256(abi.encode(uint8 kind = 0, uint256 ref = trader)).
    function traderSourceId(address trader) internal pure returns (bytes32) {
        return keccak256(abi.encode(uint8(0), uint256(uint160(trader))));
    }

    function toBytes32(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }
}
