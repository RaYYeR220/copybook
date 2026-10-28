// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IAgentRequester} from "../../../src/risk/interfaces/IAgentRequester.sol";

/// Records advanced requests (refusing an underpaid deposit) and lets a test answer one through its callback, as
/// the platform, with chosen responses and status.
contract MockAgentPlatform {
    struct Call {
        uint256 agentId;
        address callback;
        bytes4 selector;
        bytes payload;
        uint256 size;
        uint256 threshold;
        IAgentRequester.ConsensusType consensus;
        uint256 timeout;
        uint256 deposit;
    }

    /// Shannon answers 0.03 STT for a subcommittee of 3.
    uint256 public floor = 0.03 ether;
    uint256 public nextId = 101;
    bool public rejectRequests;
    bool public brokenQuotes;
    uint256[] public ids;
    mapping(uint256 => Call) internal _calls;

    function setFloor(uint256 floor_) external {
        floor = floor_;
    }

    function setRejectRequests(bool on) external {
        rejectRequests = on;
    }

    function setBrokenQuotes(bool on) external {
        brokenQuotes = on;
    }

    function getAdvancedRequestDeposit(uint256) external view returns (uint256) {
        require(!brokenQuotes, "quotes");
        return floor;
    }

    function createAdvancedRequest(
        uint256 agentId,
        address callbackAddress,
        bytes4 callbackSelector,
        bytes calldata payload,
        uint256 subcommitteeSize,
        uint256 threshold,
        IAgentRequester.ConsensusType consensusType,
        uint256 timeout
    ) external payable returns (uint256 id) {
        require(!rejectRequests, "rejected");
        require(msg.value >= floor, "deposit");
        id = nextId++;
        _calls[id] = Call(
            agentId,
            callbackAddress,
            callbackSelector,
            payload,
            subcommitteeSize,
            threshold,
            consensusType,
            timeout,
            msg.value
        );
        ids.push(id);
    }

    function count() external view returns (uint256) {
        return ids.length;
    }

    function lastId() external view returns (uint256) {
        return ids[ids.length - 1];
    }

    function callOf(uint256 id) external view returns (Call memory) {
        return _calls[id];
    }

    function respond(uint256 id, IAgentRequester.Response[] memory responses, IAgentRequester.ResponseStatus status)
        external
    {
        Call storage c = _calls[id];
        IAgentRequester.Request memory r;
        r.id = id;
        r.requester = c.callback;
        r.callbackAddress = c.callback;
        r.callbackSelector = c.selector;
        r.threshold = c.threshold;
        r.status = status;
        r.consensusType = c.consensus;
        r.responseCount = responses.length;
        (bool ok, bytes memory ret) = c.callback.call(abi.encodeWithSelector(c.selector, id, responses, status, r));
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
    }

    /// Calls `target` with `selector` as the platform for a request id it never issued.
    function respondAs(address target, bytes4 selector, uint256 id) external {
        IAgentRequester.Request memory r;
        IAgentRequester.Response[] memory none = new IAgentRequester.Response[](0);
        (bool ok, bytes memory ret) =
            target.call(abi.encodeWithSelector(selector, id, none, IAgentRequester.ResponseStatus.Success, r));
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
    }
}
