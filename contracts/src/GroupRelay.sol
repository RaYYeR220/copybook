// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {SomniaEventHandler} from "@somnia-chain/reactivity-contracts/SomniaEventHandler.sol";

interface ISourceEventSink {
    function onSourceEvent(
        bytes32 sourceId,
        uint32 group,
        address emitter,
        bytes32[] calldata topics,
        bytes calldata data
    ) external;
}

/// @notice Reactivity handler for one follower group of one source. Only the precompile can call it;
/// it forwards the event to the hub tagged with its (sourceId, group).
contract GroupRelay is SomniaEventHandler {
    ISourceEventSink public immutable hub;
    bytes32 public immutable sourceId;
    uint32 public immutable group;

    constructor(address hub_, bytes32 sourceId_, uint32 group_) {
        hub = ISourceEventSink(hub_);
        sourceId = sourceId_;
        group = group_;
    }

    function _onEvent(address emitter, bytes32[] calldata topics, bytes calldata data) internal override {
        hub.onSourceEvent(sourceId, group, emitter, topics, data);
    }
}
