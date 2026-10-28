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
    LegFailed,
    /// the increase rounds below one lot or the venue minimum, so no order can carry it
    BelowMinimum,
    /// the position already sits at the follower's maxNotional
    AtCap
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
