// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IPerpPool} from "../../src/interfaces/IDreamPerps.sol";
import {MockMarginBank} from "./MockMarginBank.sol";

/// @dev MockPerpPool with a configurable gas cost per placeOrderFor, to model Hideki's measured 1.5-7.7M
/// gas per order (an IOC crossing several levels went up to 7.7M). An order given less gas than it needs runs
/// out of gas (empty revert after burning everything), exactly like a real out-of-gas order.
/// Optionally mirrors every fill onto a `counterparty` account, as if the order matched that account's
/// resting order (used to model the source being the maker).
contract HeavyPerpPool is IPerpPool {
    error OperatorNotApproved();
    error OrderAlreadyExpired();
    error InvalidQuantity();
    error InvalidPrice();
    error ImmediateOrCancelNoFill();
    error FillOrKillNotFillable();

    MockMarginBank public immutable bank;
    uint256 public mark;
    uint256 public immutable tick;
    uint256 public immutable minQty;
    uint256 public immutable lot;
    uint256 public immutable oneBase;

    uint256 public bidDepth;
    uint256 public askDepth;
    uint256 public edgeBps;
    uint256 public burnPerOrder;
    address public counterparty;
    uint128 public orderId;

    mapping(address => mapping(address => bool)) public approved;

    constructor(MockMarginBank bank_, uint256 mark_, uint256 tick_, uint256 minQty_, uint256 lot_, uint256 oneBase_) {
        bank = bank_;
        mark = mark_;
        tick = tick_;
        minQty = minQty_;
        lot = lot_;
        oneBase = oneBase_;
    }

    function setMark(uint256 m) external {
        mark = m;
    }

    function setLiquidity(uint256 b, uint256 a, uint256 e) external {
        bidDepth = b;
        askDepth = a;
        edgeBps = e;
    }

    function setBurn(uint256 g) external {
        burnPerOrder = g;
    }

    function setCounterparty(address c) external {
        counterparty = c;
    }

    function approve(address owner, address operator) external {
        approved[owner][operator] = true;
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
        uint256 burn = burnPerOrder;
        if (burn != 0) {
            if (gasleft() < burn + 30_000) {
                assembly {
                    invalid()
                }
            }
            uint256 stopAt = gasleft() - burn;
            while (gasleft() > stopAt) {}
        }
        if (!approved[owner][msg.sender]) revert OperatorNotApproved();
        if (expireTimestampNs <= block.timestamp * 1e9) revert OrderAlreadyExpired();
        if (quantity % lot != 0 || quantity < minQty) revert InvalidQuantity();
        if (price % tick != 0) revert InvalidPrice();

        uint256 filled;
        if (isBid) {
            if (price >= mark * (1e4 + edgeBps) / 1e4) filled = quantity < askDepth ? quantity : askDepth;
            askDepth -= filled;
        } else {
            if (price <= mark * (1e4 - edgeBps) / 1e4) filled = quantity < bidDepth ? quantity : bidDepth;
            bidDepth -= filled;
        }
        if (orderType == 1 && filled != quantity) revert FillOrKillNotFillable();
        if (orderType == 2 && filled == 0) revert ImmediateOrCancelNoFill();
        if (filled > 0) {
            int256 d = isBid ? int256(filled) : -int256(filled);
            bank.applyFill(owner, d);
            address c = counterparty;
            if (c != address(0) && c != owner) bank.applyFill(c, -d);
        }
        return (true, ++orderId);
    }
}
