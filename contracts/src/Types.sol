// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

enum SourceKind {
    Trader,
    Theme
}

enum Reason {
    None,
    Paused,
    MarketNotAllowed,
    TotalCap,
    EquityFloor,
    TankEmpty,
    RiskGate,
    BandUnfilled,
    VenueRejected,
    LegFailed
}

struct Policy {
    uint32 scaleBps;
    uint128 allocation;
    uint128 maxNotional;
    uint128 maxTotalNotional;
    uint16 bandBps;
    uint128 equityFloor;
}

struct Leg {
    address pool;
    int32 weightBps;
}
