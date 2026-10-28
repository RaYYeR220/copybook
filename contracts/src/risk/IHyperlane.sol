// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice The subset of a Hyperlane v3 Mailbox the risk contracts use.
interface IMailbox {
    function localDomain() external view returns (uint32);

    function dispatch(uint32 destinationDomain, bytes32 recipientAddress, bytes calldata messageBody)
        external
        payable
        returns (bytes32 messageId);

    function quoteDispatch(uint32 destinationDomain, bytes32 recipientAddress, bytes calldata messageBody)
        external
        view
        returns (uint256 fee);
}

/// @notice A Hyperlane message recipient. The local Mailbox calls `handle` when it processes a message.
interface IMessageRecipient {
    function handle(uint32 origin, bytes32 sender, bytes calldata message) external payable;
}
