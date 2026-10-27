// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice Minimal view of a dreamDEX perp pool as used by Copybook.
interface IPerpPool {
    struct OBParams {
        uint256 tickSize;
        uint256 minQuantity;
        uint256 lotSize;
    }

    function placeOrderFor(
        address owner,
        bool isBid,
        uint64 userData,
        uint256 price,
        uint256 quantity,
        uint64 expireTimestampNs,
        uint8 orderType,
        uint8 selfMatchingOption,
        address builder,
        uint96 builderFeeBpsTimes1k
    ) external payable returns (bool success, uint128 orderId);

    function getMarkPrice() external view returns (uint256);

    function getOrderBookParameters() external view returns (OBParams memory);

    function getOneBase() external view returns (uint256);

    function marginBank() external view returns (address);
}

/// @notice Minimal view of the dreamDEX margin bank as used by Copybook.
interface IMarginBank {
    struct Position {
        int128 size;
        uint128 avgEntryPrice;
        int256 entryFundingIndex;
        uint64 lastUpdatedTimestampNs;
    }

    event PositionUpdated(
        address indexed account,
        address indexed perpPool,
        int128 newSize,
        uint128 avgEntryPrice,
        int256 realizedPnl,
        int256 entryFundingIndex
    );

    function getPosition(address account, address pool) external view returns (Position memory);

    function getAccountHealth(address account)
        external
        view
        returns (int256 equity, uint256 imReq, uint256 mmReq, uint256 cmReq);
}

/// @notice Optional external gate consulted before a position-increasing copy.
/// The hub treats address(0) as "no gate".
interface IRiskGate {
    function allowIncrease(bytes32 sourceId) external view returns (bool);
}
