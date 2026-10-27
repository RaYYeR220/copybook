// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IPerpPool} from "../../src/interfaces/IDreamPerps.sol";
import {MockMarginBank} from "./MockMarginBank.sol";

contract MockPerpPool is IPerpPool {
    error OperatorNotApproved();
    error OrderAlreadyExpired();
    error InvalidQuantity();
    error InvalidPrice();
    error ImmediateOrCancelNoFill();
    error FillOrKillNotFilled();

    event MockFill(address owner, bool isBid, uint256 qty, uint256 price);

    MockMarginBank public immutable bank;
    uint256 public mark;
    uint256 public immutable tick;
    uint256 public immutable minQty;
    uint256 public immutable lot;
    uint256 public immutable oneBase;

    uint256 public bidDepth;
    uint256 public askDepth;
    uint256 public edgeBps;
    uint128 public orderId;

    mapping(address => mapping(address => bool)) public approved;
    mapping(address => bytes) internal _revertFor;
    bytes internal _revertAll;
    mapping(address => bool) public bombFor;

    constructor(MockMarginBank bank_, uint256 mark_, uint256 tick_, uint256 minQty_, uint256 lot_, uint256 oneBase_) {
        bank = bank_;
        mark = mark_;
        tick = tick_;
        minQty = minQty_;
        lot = lot_;
        oneBase = oneBase_;
    }

    function setMark(uint256 mark_) external {
        mark = mark_;
    }

    function setLiquidity(uint256 bidDepthQty, uint256 askDepthQty, uint256 bandEdgeBps) external {
        bidDepth = bidDepthQty;
        askDepth = askDepthQty;
        edgeBps = bandEdgeBps;
    }

    function approve(address owner, address operator) external {
        approved[owner][operator] = true;
    }

    /// @dev Makes every call revert with exactly `data` (empty clears).
    function setRevert(bytes calldata data) external {
        _revertAll = data;
    }

    /// @dev Makes calls for `owner` revert with exactly `data` (empty clears).
    /// @dev Makes orders for `owner` burn all the gas they are given, as an order that runs out of gas.
    function setBombFor(address owner, bool on) external {
        bombFor[owner] = on;
    }

    function setRevertFor(address owner, bytes calldata data) external {
        _revertFor[owner] = data;
    }

    function getMarkPrice() external view returns (uint256) {
        return mark;
    }

    function getOrderBookParameters() external view returns (OBParams memory) {
        return OBParams({tickSize: tick, minQuantity: minQty, lotSize: lot});
    }

    function getOneBase() external view returns (uint256) {
        return oneBase;
    }

    function marginBank() external view returns (address) {
        return address(bank);
    }

    function placeOrderFor(
        address owner,
        bool isBid,
        uint64,
        uint256 price,
        uint256 quantity,
        uint64 expireTimestampNs,
        uint8 orderType,
        uint8,
        address,
        uint96
    ) external payable returns (bool, uint128) {
        if (bombFor[owner]) {
            assembly {
                invalid()
            }
        }
        _maybeRevert(_revertAll);
        _maybeRevert(_revertFor[owner]);
        if (!approved[owner][msg.sender]) revert OperatorNotApproved();
        if (expireTimestampNs <= block.timestamp * 1e9) revert OrderAlreadyExpired();
        if (quantity % lot != 0 || quantity < minQty) revert InvalidQuantity();
        if (price % tick != 0) revert InvalidPrice();

        uint256 filled;
        uint256 level;
        if (isBid) {
            level = mark * (1e4 + edgeBps) / 1e4;
            if (price >= level) filled = quantity < askDepth ? quantity : askDepth;
            askDepth -= filled;
        } else {
            level = mark * (1e4 - edgeBps) / 1e4;
            if (price <= level) filled = quantity < bidDepth ? quantity : bidDepth;
            bidDepth -= filled;
        }

        if (orderType == 1 && filled != quantity) revert FillOrKillNotFilled();
        if (orderType == 2 && filled == 0) revert ImmediateOrCancelNoFill();

        if (filled > 0) {
            bank.applyFill(owner, isBid ? int256(filled) : -int256(filled));
            emit MockFill(owner, isBid, filled, level);
        }
        return (true, ++orderId);
    }

    function _maybeRevert(bytes memory d) internal pure {
        if (d.length == 0) return;
        assembly {
            revert(add(d, 32), mload(d))
        }
    }
}
