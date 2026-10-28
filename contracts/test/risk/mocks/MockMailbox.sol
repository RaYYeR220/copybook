// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IMessageRecipient} from "../../../src/risk/IHyperlane.sol";

/// One side of a Hyperlane lane. `dispatch` records the message; `deliverNext` hands the oldest undelivered one
/// to the paired mailbox, which calls the recipient's `handle` as its local mailbox with the true origin and
/// sender. `process` lets a test make this mailbox deliver anything (any origin, any sender).
contract MockMailbox {
    struct Message {
        address sender;
        uint32 destination;
        bytes32 recipient;
        bytes body;
        uint256 value;
    }

    uint32 public immutable localDomain;
    MockMailbox public remote;
    uint256 public fee;
    uint256 public delivered;
    Message[] internal _outbox;

    constructor(uint32 domain) {
        localDomain = domain;
    }

    function pair(MockMailbox other) external {
        remote = other;
    }

    function setFee(uint256 fee_) external {
        fee = fee_;
    }

    function quoteDispatch(uint32, bytes32, bytes calldata) external view returns (uint256) {
        return fee;
    }

    function dispatch(uint32 destination, bytes32 recipient, bytes calldata body)
        external
        payable
        returns (bytes32 id)
    {
        require(msg.value >= fee, "fee");
        _outbox.push(Message(msg.sender, destination, recipient, body, msg.value));
        id = keccak256(abi.encode(localDomain, _outbox.length));
    }

    function outboxLength() external view returns (uint256) {
        return _outbox.length;
    }

    function undelivered() external view returns (uint256) {
        return _outbox.length - delivered;
    }

    function message(uint256 i) external view returns (Message memory) {
        return _outbox[i];
    }

    function last() external view returns (Message memory) {
        return _outbox[_outbox.length - 1];
    }

    function deliverNext() external {
        Message memory m = _outbox[delivered++];
        require(m.destination == remote.localDomain(), "domain");
        remote.process(localDomain, bytes32(uint256(uint160(m.sender))), address(uint160(uint256(m.recipient))), m.body);
    }

    function process(uint32 origin, bytes32 sender, address recipient, bytes calldata body) external {
        IMessageRecipient(recipient).handle(origin, sender, body);
    }
}
