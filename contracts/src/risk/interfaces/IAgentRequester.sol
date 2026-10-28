// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice Somnia's agent platform: asks a subcommittee of validators to run an agent and calls back with
/// their responses. Shannon testnet (50312): 0x037Bb9C718F3f7fe5eCBDB0b600D607b52706776.
/// @dev Deposit for an advanced request = `getAdvancedRequestDeposit(subcommitteeSize)` plus the per-validator
/// reward times the subcommittee size; runners skip requests whose per-validator budget is below their price.
interface IAgentRequester {
    enum ConsensusType {
        Majority,
        Threshold
    }

    enum ResponseStatus {
        None, // uninitialised
        Pending, // awaiting responses
        Success, // consensus reached
        Failed, // validators reported failure
        TimedOut // deadline passed
    }

    struct Response {
        address validator;
        bytes result;
        ResponseStatus status;
        uint256 receipt;
        uint256 timestamp;
        uint256 executionCost;
    }

    struct Request {
        uint256 id;
        address requester;
        address callbackAddress;
        bytes4 callbackSelector;
        address[] subcommittee;
        Response[] responses;
        uint256 responseCount;
        uint256 failureCount;
        uint256 threshold;
        uint256 createdAt;
        uint256 deadline;
        ResponseStatus status;
        ConsensusType consensusType;
        uint256 remainingBudget;
        uint256 perAgentBudget;
    }

    function createRequest(uint256 agentId, address callbackAddress, bytes4 callbackSelector, bytes calldata payload)
        external
        payable
        returns (uint256 requestId);

    function createAdvancedRequest(
        uint256 agentId,
        address callbackAddress,
        bytes4 callbackSelector,
        bytes calldata payload,
        uint256 subcommitteeSize,
        uint256 threshold,
        ConsensusType consensusType,
        uint256 timeout
    ) external payable returns (uint256 requestId);

    function getRequestDeposit() external view returns (uint256);

    function getAdvancedRequestDeposit(uint256 subcommitteeSize) external view returns (uint256);
}

/// @notice The platform's callback shape: `(requestId, responses, status, request)`. A consumer may register
/// any selector with this signature.
interface IAgentConsumer {
    function handleResponse(
        uint256 requestId,
        IAgentRequester.Response[] memory responses,
        IAgentRequester.ResponseStatus status,
        IAgentRequester.Request memory request
    ) external;
}

/// @notice The JSON API Request base agent (id 13174292974160097713), used only for its selectors when
/// encoding a request payload. Each validator GETs `url` and extracts `selector` (dot path) from the JSON body.
interface IJsonApiAgent {
    function fetchString(string calldata url, string calldata selector) external returns (string memory);

    function fetchUint(string calldata url, string calldata selector, uint8 decimals) external returns (uint256);
}

/// @notice The LLM Inference base agent (id 12847293847561029384), used only for its selectors when encoding
/// a request payload.
interface ILLMInferenceAgent {
    /// @param allowedValues when non-empty, the answers the model is restricted to
    function inferString(
        string calldata prompt,
        string calldata system,
        bool chainOfThought,
        string[] calldata allowedValues
    ) external returns (string memory);

    function inferNumber(
        string calldata prompt,
        string calldata system,
        int256 minValue,
        int256 maxValue,
        bool chainOfThought
    ) external returns (int256);
}
