// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {MockMarginBank} from "./mocks/MockMarginBank.sol";
import {MockPerpPool} from "./mocks/MockPerpPool.sol";
import {MockReactivity} from "./mocks/MockReactivity.sol";

abstract contract Base is Test {
    address internal constant REACTIVITY = address(0x0100);

    MockMarginBank internal bank;
    MockPerpPool internal btc;
    MockPerpPool internal eth;
    MockReactivity internal reactivity = MockReactivity(REACTIVITY);

    function setUp() public virtual {
        bank = new MockMarginBank();
        btc = new MockPerpPool(bank, 80_000e18, 1e17, 13_000, 1_000, 1e8);
        eth = new MockPerpPool(bank, 2_300e18, 1e16, 4e15, 1e14, 1e18);
        bank.registerPool(address(btc));
        bank.registerPool(address(eth));
        vm.etch(REACTIVITY, address(new MockReactivity()).code);
    }

    function _seedLiquidity(MockPerpPool pool, uint256 depth, uint256 edgeBps) internal {
        pool.setLiquidity(depth, depth, edgeBps);
    }
}
