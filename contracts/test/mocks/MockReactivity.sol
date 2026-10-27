// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {
    ISomniaReactivityPrecompile
} from "@somnia-chain/reactivity-contracts/interfaces/ISomniaReactivityPrecompile.sol";
import {ISomniaEventHandler} from "@somnia-chain/reactivity-contracts/interfaces/ISomniaEventHandler.sol";
import {SomniaExtensions} from "@somnia-chain/reactivity-contracts/interfaces/SomniaExtensions.sol";

/// @dev Etch this contract's code at address(0x0100). Storage is written at the etched address.
contract MockReactivity is ISomniaReactivityPrecompile {
    error InsufficientBalance();
    error GasLimitExceeded();
    error HandlerZeroAddress();
    error NotOwner();
    error UnknownSubscription();

    uint256 public count;
    mapping(uint256 => SubscriptionData) internal _subs;
    mapping(uint256 => address) internal _owners;

    function subscribe(SubscriptionData calldata d) external returns (uint256 id) {
        if (msg.sender.balance < SomniaExtensions.SUBSCRIPTION_OWNER_MINIMUM_BALANCE) revert InsufficientBalance();
        if (d.gasLimit > SomniaExtensions.MAXIMUM_HANDLER_GAS_LIMIT) revert GasLimitExceeded();
        if (d.handlerContractAddress == address(0)) revert HandlerZeroAddress();
        id = ++count;
        _subs[id] = d;
        _owners[id] = msg.sender;
        emit SubscriptionCreated(id, msg.sender, d);
    }

    function unsubscribe(uint256 id) external {
        if (_owners[id] == address(0)) revert UnknownSubscription();
        if (_owners[id] != msg.sender) revert NotOwner();
        delete _subs[id];
        delete _owners[id];
        emit SubscriptionRemoved(id, msg.sender);
    }

    function getSubscriptionInfo(uint256 id) public view returns (SubscriptionData memory, address) {
        return (_subs[id], _owners[id]);
    }

    function getSubscription(uint256 id) external view returns (SubscriptionData memory, address) {
        return getSubscriptionInfo(id);
    }

    /// @dev Drops a subscription without its owner, as the chain may when it removes one.
    function forceRemove(uint256 id) external {
        delete _subs[id];
        delete _owners[id];
    }

    /// @dev Runs at 0x0100, so msg.sender seen by the handler is the precompile address.
    function fire(uint256 id, address emitter, bytes32[] calldata topics, bytes calldata data) external {
        address handler = _subs[id].handlerContractAddress;
        if (handler == address(0)) revert UnknownSubscription();
        ISomniaEventHandler(handler).onEvent(emitter, topics, data);
    }
}
