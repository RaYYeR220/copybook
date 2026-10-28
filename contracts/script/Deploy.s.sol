// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {CopybookHub} from "../src/CopybookHub.sol";
import {ThemeRegistry} from "../src/ThemeRegistry.sol";
import {IMarginBank} from "../src/interfaces/IDreamPerps.sol";

/// @notice Deploys ThemeRegistry and CopybookHub (forge deploys and links CopyEngine) and funds the hub's
/// subscription balance. Env, all optional: MARGIN_BANK, GROUP_SIZE (8), OWNER (the broadcaster), HUB_FUNDING
/// (40 STT; the Reactivity precompile requires 32 STT on a subscription owner).
contract Deploy is Script {
    address internal constant HIDEKI_MARGIN_BANK = 0x478769E1177C0773c43A593DCCc4Ad15F15F1394;

    function run() external returns (CopybookHub hub, ThemeRegistry themes) {
        address bank = vm.envOr("MARGIN_BANK", HIDEKI_MARGIN_BANK);
        uint32 groupSize = uint32(vm.envOr("GROUP_SIZE", uint256(8)));
        uint256 funding = vm.envOr("HUB_FUNDING", uint256(40 ether));

        vm.startBroadcast();
        (, address sender,) = vm.readCallers();
        address owner = vm.envOr("OWNER", sender);
        themes = new ThemeRegistry(bank);
        hub = new CopybookHub(IMarginBank(bank), themes, groupSize, owner);
        (bool ok,) = address(hub).call{value: funding}("");
        require(ok, "funding failed");
        vm.stopBroadcast();

        console.log("ThemeRegistry", address(themes));
        console.log("CopybookHub  ", address(hub));
        console.log("owner        ", owner);
    }
}
