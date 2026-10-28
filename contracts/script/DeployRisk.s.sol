// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {RiskGate} from "../src/risk/RiskGate.sol";
import {RiskReviewer} from "../src/risk/RiskReviewer.sol";
import {IMailbox} from "../src/risk/IHyperlane.sol";
import {IAgentRequester} from "../src/risk/interfaces/IAgentRequester.sol";

/// @notice Deploys the risk module, one run per chain, Shannon first:
/// - on Shannon (50312), the RiskReviewer. Env: BASE_URL (required: the risk summary endpoint prefix, ending in
///   `/`), GATE (optional: the gate's address when already known; otherwise the broadcaster stands in until the
///   owner calls `setGate`), OWNER (optional, default the broadcaster).
/// - on Hideki (50383), the RiskGate, pointed at the reviewer. Env: REVIEWER (required), OWNER (optional; when it
///   is not the broadcaster, the owner calls `setReviewer` instead).
/// Wiring that needs the other side's address afterwards: `reviewer.setGate(gate)` on Shannon and the hub's
/// `setRiskGate(gate)` on Hideki.
contract DeployRisk is Script {
    uint256 internal constant SHANNON = 50312;
    uint256 internal constant HIDEKI = 50383;
    address internal constant SHANNON_MAILBOX = 0xF805734aAC42cf238eAef9E905e3A04F2Ab554f9;
    address internal constant HIDEKI_MAILBOX = 0xD7C2E95c62De3c0ad95b2C1cf08E4B85DF6b332D;
    address internal constant AGENT_PLATFORM = 0x037Bb9C718F3f7fe5eCBDB0b600D607b52706776;

    function run() external {
        if (block.chainid == SHANNON) deployReviewer();
        else if (block.chainid == HIDEKI) deployGate();
        else revert("DeployRisk: run on Shannon (50312) or Hideki (50383)");
    }

    function deployReviewer() public returns (RiskReviewer reviewer) {
        string memory baseUrl = vm.envString("BASE_URL");
        vm.startBroadcast();
        (, address sender,) = vm.readCallers();
        address owner = vm.envOr("OWNER", sender);
        address gate = vm.envOr("GATE", sender);
        reviewer = new RiskReviewer(
            owner, IAgentRequester(AGENT_PLATFORM), IMailbox(SHANNON_MAILBOX), uint32(HIDEKI), gate, baseUrl
        );
        vm.stopBroadcast();

        console.log("RiskReviewer", address(reviewer));
        console.log("owner       ", owner);
        console.log("gate        ", gate);
        console.log("baseUrl     ", baseUrl);
    }

    function deployGate() public returns (RiskGate gate) {
        address reviewer = vm.envAddress("REVIEWER");
        vm.startBroadcast();
        (, address sender,) = vm.readCallers();
        address owner = vm.envOr("OWNER", sender);
        gate = new RiskGate(owner, IMailbox(HIDEKI_MAILBOX), uint32(SHANNON));
        if (owner == sender) gate.setReviewer(reviewer);
        vm.stopBroadcast();

        console.log("RiskGate", address(gate));
        console.log("owner   ", owner);
        console.log("reviewer", gate.reviewer());
    }
}
