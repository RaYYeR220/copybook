# Risk review scorecard

Copybook's AI guard is a committee of Somnia validators. The `RiskReviewer` on Shannon has one committee fetch a
trader's 30-day summary from our public endpoint and another classify it as OK, CAUTION or BLOCK. The verdict travels
over Hyperlane to the `RiskGate` on Hideki, and the hub then refuses new size to guarded followers of a BLOCKed
trader.

This page measures how faithfully the live committee applies a published rubric to real Hideki traders. We wrote down
the expected answer for every trader and committed it before requesting a single review. The scorecard compares the
committee's verdicts with that answer key.

**Result: 14 of 20 verdicts match the rubric.**
- Every trader the rubric blocks was blocked: 6 of 6, with no misses.
- Three traders were blocked that the rubric would not block.
- Three thin-history traders were rated OK where the rubric says CAUTION.
- The gate acts only on BLOCK, so for "can a guarded follower add size" the committee was right 17 times in 20. All 3
  errors are false blocks.
- No review failed, and every committee answered unanimously.

## The rubric

The rubric is published in [`rubric.ts`](rubric.ts), which also applies it in code. It reads the summary keys, and
n/a means unknown, not safe.

- **BLOCK** if `liquidations30d >= 2`, or `maxDrawdownPct30d` is present and `>= 50`.
- **CAUTION** if the trader is not BLOCKed and any of these holds:
  - `liquidations30d == 1`
  - `trades30d < 10`
  - `history=none`
  - `partial=1`
  - `maxDrawdownPct30d` is present and `>= 25`
- **OK** otherwise.

The system prompt on the live reviewer states the same rule in words. It was set with
[`setSystemPrompt`](https://shannon-explorer.somnia.network/tx/0x20629ab6154341a9f64d046db663f332eb77cb73910d43129e8b12f8fc2d5d50)
(Shannon block 526215451, 13:56:32 UTC):

> You review perpetual-futures traders for people who copy their positions automatically. Apply this rubric exactly to
> the 30-day stats (key=value; n/a means unknown, not safe). BLOCK if liquidations30d is 2 or more, or
> maxDrawdownPct30d is present and at least 50. Otherwise CAUTION if liquidations30d is 1, or trades30d is below 10,
> or history=none, or partial=1, or maxDrawdownPct30d is present and at least 25. Otherwise OK. Answer with exactly one
> word: OK, CAUTION or BLOCK.

The reviewer sends this prompt, then `\nStats: `, then the summary, to the LLM agent with
`inferString(prompt, "", false, ["OK", "CAUTION", "BLOCK"])`. The committee has 3 validators, and a verdict needs 2 of
them to agree.

## Pre-registration

| step | when (UTC, 2026-10-28) | evidence |
|---|---|---|
| summaries fetched from `https://copybook-eosin.vercel.app/api/risk/<trader>` | 13:54:21 – 13:55:11 | `fetchedAt` per trader in [`answer-key.json`](answer-key.json) |
| answer key committed | 13:55:50 | commit `6b1b07437b29c95c8d41916858cabdc73a7d6e07` |
| commit hash and key hash written on chain | 13:56:19 | [Hideki tx 0x1f70dc46…](https://explorer.testnet.somnia.network/tokyo/tx/0x1f70dc46bfee488d482591cffb54200795ed332b903678dfa77c85359a4dcd31) (block 35426023) |
| rubric prompt set on the reviewer | 13:56:32 | [Shannon tx 0x20629ab6…](https://shannon-explorer.somnia.network/tx/0x20629ab6154341a9f64d046db663f332eb77cb73910d43129e8b12f8fc2d5d50) |
| first review requested | 13:57:18 | row 1 below |
| last verdict delivered to Hideki | 14:07:26 | row 20 below |

The anchor transaction is a zero-value self-transfer from the hub owner. Its input is the 20-byte commit hash
followed by the keccak256 of `eval/answer-key.json` as committed (`0x426693730e7f5f7bc606817c7a7fbe97f504abcdb89e7d83d3a6a89bbc2b4767`).
A git timestamp can be rewritten, but this block cannot. The key existed before any review of the sample was paid for
(reviews have nonces 4 to 23 on the gate).

For each trader the key holds:
- the summary exactly as the endpoint served it;
- `summaryHash` = keccak256 of the summary's bytes, which is how `RiskReviewer` hashes the summary the committee agreed on;
- the rubric's tier and the rules that fired.

## The sample

The sample is 20 real Hideki traders, selected by `npm run eval select` from the dreamDEX indexer:

| category | count |
|---|---|
| 2 or more liquidations | 6 |
| exactly one liquidation | 4 |
| thin (fewer than 10 trades) | 3 |
| clean (no liquidation, 10 or more trades) | 6 |
| our e2e leader | 1 |

- **Pools.** Candidates come from fixed-order pools: the two non-leader traders of the first live run, then accounts
  from the latest liquidation and position-change rows, then the leaderboard candidates.
- **Taking a trader.** A screened account is taken when the quota for its category is still open. The selection rule,
  the pools and all 59 screened accounts are listed in the key.
- **Exclusions.** Our own wallets and contracts are excluded, except the leader.
- **Expected tiers.** 5 OK, 9 CAUTION, 6 BLOCK. Two "clean" traders are high-frequency accounts above the endpoint's
  2,000-row cap, so their summaries carry `partial=1` and the rubric says CAUTION.

## Confusion matrix

Rows show the rubric's tier and columns show the committee's tier.

| expected \ committee | OK | CAUTION | BLOCK | no verdict |
|---|---|---|---|---|
| **OK** | **3** | 0 | 2 | 0 |
| **CAUTION** | 3 | **5** | 1 | 0 |
| **BLOCK** | 0 | 0 | **6** | 0 |

Four active traders traded between pre-registration and their review, so the committee saw a different summary
than the key holds (rows 12, 13, 15 and 16: their PnL or trade count moved). For each of them the rubric gives the
same tier on the summary the committee saw as on the pre-registered one, so scoring against either gives the matrix
above. The other 16 summaries are byte-identical to the key.

## Per trader

In the table:
- **Rule inputs** are the keys the rubric reads, from the summary the committee saw. Full summaries are listed below
  the table.
- **Committee (OK/CAU/BLK)** gives the tier, then the votes for each tier. A tier in bold disagrees with the rubric.
- **Gate** is what the gate did with the verdict on Hideki.

| # | trader | picked as | rule inputs seen | seen = key | expected | committee (OK/CAU/BLK) | gate |
|---|---|---|---|---|---|---|---|
| 1 | [`0xfc2F…7fd2`](https://explorer.testnet.somnia.network/tokyo/address/0xfc2Fb08CCCF87BFC472cded8E7eBEF588fCF7fd2) | clean | liq 0 · trades 113 | yes | OK | **BLOCK** (0/0/3) | VerdictReceived BLOCK |
| 2 | [`0xA14d…3D14`](https://explorer.testnet.somnia.network/tokyo/address/0xA14d4561F2697859AB6c2d5eb62E1172a6cc3D14) | liquidated-2+ | liq 3 · trades 115 · dd% 92.2 | yes | BLOCK | BLOCK (0/0/3) | VerdictReceived BLOCK |
| 3 | [`0x220c…AF00`](https://explorer.testnet.somnia.network/tokyo/address/0x220c695eFB9a6914a334Ac7b783012F43C0BAF00) | liquidated-2+ | liq 6 · trades 633 | yes | BLOCK | BLOCK (0/0/3) | VerdictReceived BLOCK |
| 4 | [`0x5521…1e69`](https://explorer.testnet.somnia.network/tokyo/address/0x5521160E05bB130783E003F746F03d9D31ea1e69) | liquidated-2+ | liq 3 · trades 334 | yes | BLOCK | BLOCK (0/0/3) | VerdictReceived BLOCK |
| 5 | [`0x1fAe…BFc7`](https://explorer.testnet.somnia.network/tokyo/address/0x1fAeD318FCeD713cC5764BD7B4974b39DDF5BFc7) | liquidated-2+ | liq 3 · trades 38 | yes | BLOCK | BLOCK (0/0/3) | VerdictReceived BLOCK |
| 6 | [`0x7c30…5b96`](https://explorer.testnet.somnia.network/tokyo/address/0x7c30179b81212f592f7D24d37aCbEC408e905b96) | liquidated-2+ | liq 3 · trades 60 | yes | BLOCK | BLOCK (0/0/3) | VerdictReceived BLOCK |
| 7 | [`0x2E6c…42b7`](https://explorer.testnet.somnia.network/tokyo/address/0x2E6c0CD1c011Ec7e7a2d22fB464d7c63d53842b7) | liquidated-2+ | liq 4 · trades 9 | yes | BLOCK | BLOCK (0/0/3) | VerdictReceived BLOCK |
| 8 | [`0xb870…50a8`](https://explorer.testnet.somnia.network/tokyo/address/0xb8700E8d07Bd029f7dD3CE6CC97Fe936D70c50a8) | liquidated-1 | liq 1 · trades 695 | yes | CAUTION | CAUTION (0/3/0) | VerdictReceived CAUTION |
| 9 | [`0xCd50…2D7f`](https://explorer.testnet.somnia.network/tokyo/address/0xCd509d80cDB707dD1871a8aD10b8A399696a2D7f) | liquidated-1 | liq 1 · trades 5 | yes | CAUTION | CAUTION (0/3/0) | VerdictReceived CAUTION |
| 10 | [`0x8B83…e1e4`](https://explorer.testnet.somnia.network/tokyo/address/0x8B834Ce8F8D18D4247F600FBF91C74A8F0ABe1e4) | liquidated-1 | liq 1 · trades 5 | yes | CAUTION | CAUTION (0/3/0) | VerdictReceived CAUTION |
| 11 | [`0xF3ed…08F8`](https://explorer.testnet.somnia.network/tokyo/address/0xF3ed3F5b90A13b39f30759E9800ec638711008F8) | liquidated-1 | liq 1 · trades 555 | yes | CAUTION | CAUTION (0/3/0) | VerdictReceived CAUTION |
| 12 | [`0x8573…d02c`](https://explorer.testnet.somnia.network/tokyo/address/0x857387a56F7ceE3246860a8A470123C31bB0d02c) | clean | liq 0 · trades 2000 · partial=1 | no | CAUTION | CAUTION (0/3/0) | VerdictReceived CAUTION |
| 13 | [`0x0a72…8Ff4`](https://explorer.testnet.somnia.network/tokyo/address/0x0a72b2e45fB68a8Ff4B0945Ee8104cb5a97D8Ff4) | clean | liq 0 · trades 2000 · partial=1 | no | CAUTION | **BLOCK** (0/0/3) | VerdictReceived BLOCK |
| 14 | [`0x20A0…bA88`](https://explorer.testnet.somnia.network/tokyo/address/0x20A0d517f1b60fd3041B49d7B97b529964c7bA88) | clean | liq 0 · trades 15 | yes | OK | **BLOCK** (0/0/3) | VerdictReceived BLOCK |
| 15 | [`0xfed4…7749`](https://explorer.testnet.somnia.network/tokyo/address/0xfed46fe76Ac5e98f1C969Bc10eFB96014Dc17749) | clean | liq 0 · trades 16 | no | OK | OK (3/0/0) | VerdictReceived OK |
| 16 | [`0xE46c…9999`](https://explorer.testnet.somnia.network/tokyo/address/0xE46cd08B8921aFD922051Ee4D11701aEf68d9999) | clean | liq 0 · trades 127 | no | OK | OK (3/0/0) | VerdictReceived OK |
| 17 | [`0x2c12…2fd8`](https://explorer.testnet.somnia.network/tokyo/address/0x2c12A7432362E335B7A0B2ACCA2F6Ae17a1f2fd8) | thin | liq 0 · trades 3 | yes | CAUTION | **OK** (3/0/0) | VerdictReceived OK |
| 18 | [`0xb9c0…37F3`](https://explorer.testnet.somnia.network/tokyo/address/0xb9c0424B350be6Bb438eE3fdda981212d42037F3) | thin | liq 0 · trades 7 | yes | CAUTION | **OK** (3/0/0) | VerdictReceived OK |
| 19 | [`0x10ea…2E90`](https://explorer.testnet.somnia.network/tokyo/address/0x10eae18964db8EE7981B51fd93b3B163e8dF2E90) | thin | liq 0 · trades 5 | yes | CAUTION | **OK** (3/0/0) | VerdictReceived OK |
| 20 | [`0xA1d0…7b5d`](https://explorer.testnet.somnia.network/tokyo/address/0xA1d0CB85c869e534Fe1e0c22af3b238301157b5d) | leader | liq 0 · trades 45 | yes | OK | OK (3/0/0) | BlockHeld OK |

<details><summary>Summaries the committee saw (from each review's <code>SummaryReceived</code> event)</summary>

| # | summary |
|---|---|
| 1 | `trades30d=113 activeDays30d=7 markets=3 realizedPnl30d=+3773.3 liquidations30d=0 maxDrawdown30d=679.3 avgLeverage=n/a lastActive=2026-10-22` |
| 2 | `trades30d=115 activeDays30d=6 markets=3 realizedPnl30d=-979.7 liquidations30d=3 maxDrawdown30d=2609.9 maxDrawdownPct30d=92.2 avgLeverage=17.0 lastActive=2026-10-26` |
| 3 | `trades30d=633 activeDays30d=12 markets=10 realizedPnl30d=+3086.5 liquidations30d=6 maxDrawdown30d=10649.7 avgLeverage=n/a lastActive=2026-10-26` |
| 4 | `trades30d=334 activeDays30d=11 markets=5 realizedPnl30d=-2056.9 liquidations30d=3 maxDrawdown30d=2923.4 avgLeverage=n/a lastActive=2026-10-28` |
| 5 | `trades30d=38 activeDays30d=6 markets=3 realizedPnl30d=-1653.6 liquidations30d=3 maxDrawdown30d=2437.7 avgLeverage=n/a lastActive=2026-10-27` |
| 6 | `trades30d=60 activeDays30d=5 markets=9 realizedPnl30d=-1758.5 liquidations30d=3 maxDrawdown30d=4942.4 avgLeverage=n/a lastActive=2026-10-27` |
| 7 | `trades30d=9 activeDays30d=2 markets=1 realizedPnl30d=-1350.9 liquidations30d=4 maxDrawdown30d=1350.9 avgLeverage=n/a lastActive=2026-10-26` |
| 8 | `trades30d=695 activeDays30d=1 markets=14 realizedPnl30d=-43.1 liquidations30d=1 maxDrawdown30d=43.1 avgLeverage=n/a lastActive=2026-10-28` |
| 9 | `trades30d=5 activeDays30d=1 markets=1 realizedPnl30d=-578.0 liquidations30d=1 maxDrawdown30d=578.0 avgLeverage=n/a lastActive=2026-10-28` |
| 10 | `trades30d=5 activeDays30d=1 markets=1 realizedPnl30d=-516.7 liquidations30d=1 maxDrawdown30d=516.7 avgLeverage=n/a lastActive=2026-10-28` |
| 11 | `trades30d=555 activeDays30d=16 markets=5 realizedPnl30d=+1156.3 liquidations30d=1 maxDrawdown30d=4916.4 avgLeverage=n/a lastActive=2026-10-28` |
| 12 | `trades30d=2000 activeDays30d=1 markets=1 realizedPnl30d=+188.6 liquidations30d=0 maxDrawdown30d=0.0 avgLeverage=n/a lastActive=2026-10-28 partial=1` |
| 13 | `trades30d=2000 activeDays30d=1 markets=1 realizedPnl30d=+25.6 liquidations30d=0 maxDrawdown30d=0.0 avgLeverage=n/a lastActive=2026-10-28 partial=1` |
| 14 | `trades30d=15 activeDays30d=2 markets=2 realizedPnl30d=-464.9 liquidations30d=0 maxDrawdown30d=572.7 avgLeverage=n/a lastActive=2026-10-28` |
| 15 | `trades30d=16 activeDays30d=2 markets=2 realizedPnl30d=-73.3 liquidations30d=0 maxDrawdown30d=208.0 avgLeverage=n/a lastActive=2026-10-28` |
| 16 | `trades30d=127 activeDays30d=7 markets=4 realizedPnl30d=-1018.8 liquidations30d=0 maxDrawdown30d=1908.7 avgLeverage=n/a lastActive=2026-10-28` |
| 17 | `trades30d=3 activeDays30d=1 markets=1 realizedPnl30d=-0.2 liquidations30d=0 maxDrawdown30d=0.2 avgLeverage=n/a lastActive=2026-10-28` |
| 18 | `trades30d=7 activeDays30d=2 markets=2 realizedPnl30d=+273.6 liquidations30d=0 maxDrawdown30d=0.0 avgLeverage=n/a lastActive=2026-10-28` |
| 19 | `trades30d=5 activeDays30d=1 markets=1 realizedPnl30d=-0.2 liquidations30d=0 maxDrawdown30d=0.2 avgLeverage=n/a lastActive=2026-10-28` |
| 20 | `trades30d=45 activeDays30d=2 markets=2 realizedPnl30d=-0.3 liquidations30d=0 maxDrawdown30d=0.3 avgLeverage=n/a lastActive=2026-10-28` |

</details>

### Transactions

Each review is five transactions, linked in the table below:
1. The gate's `requestReview` on Hideki.
2. The Hyperlane delivery on Shannon. Its `SummaryRequested` event asks the JSON committee for the summary.
3. The JSON committee's callback. Its `SummaryReceived` and `VerdictRequested` events ask the LLM committee for a tier.
4. The LLM committee's callback, with `VerdictTallied` and `VerdictSent`.
5. The Hyperlane delivery back to the gate on Hideki.

The callbacks are sent by a committee validator, and each validator's answer is decoded from them into
[`results.json`](results.json).

| # | Hideki: requestReview | Shannon: summary request | Shannon: verdict request | Shannon: verdict | Hideki: verdict delivered |
|---|---|---|---|---|---|
| 1 | [0x429ebe59…](https://explorer.testnet.somnia.network/tokyo/tx/0x429ebe597e2ad1ef22adf02edac7b3a0c72efedd957d10188b69c7ce196498cb) | [0x6152e0ae…](https://shannon-explorer.somnia.network/tx/0x6152e0aed5abe60176ef781ba6370729a8662da5676b40434cbbf2ac35c83b56) | [0x2e47a6f4…](https://shannon-explorer.somnia.network/tx/0x2e47a6f4637f08bccd5077165771c704a570f9318d668c0e28e524434aa17417) | [0x12504a2f…](https://shannon-explorer.somnia.network/tx/0x12504a2f34b74e9f0655ee665d932390fb5835830fc69b111b4a288864dbe10f) | [0xd528eb5f…](https://explorer.testnet.somnia.network/tokyo/tx/0xd528eb5fc9b7cc6f0e3fa092a826cdbf55963622d22410ce1fe96b30bfb94a22) |
| 2 | [0x461f5803…](https://explorer.testnet.somnia.network/tokyo/tx/0x461f5803b349ae6ea940c2f1f2e9ab0a78e1e750088460d128d0edf813399ebb) | [0xf1241c55…](https://shannon-explorer.somnia.network/tx/0xf1241c55a7e251f54133b16ada03315ff2db5400004dc3f9f2bf6965a24b7af0) | [0x9ee226a6…](https://shannon-explorer.somnia.network/tx/0x9ee226a66dfa7fa0c86e4b65fd09c0784a32f2547904f5355a2d3ca07f5507c9) | [0x526e911b…](https://shannon-explorer.somnia.network/tx/0x526e911bcaa91078c23de220605d4b2e8026a8b75eba2dbf24f6697c7c15a257) | [0xe480caa6…](https://explorer.testnet.somnia.network/tokyo/tx/0xe480caa6a349a7c44f53e3c966c6064a22b03f6ea7a32b7373bce9bce6042a1a) |
| 3 | [0x89dd115e…](https://explorer.testnet.somnia.network/tokyo/tx/0x89dd115eeb2b2d8dba062d5a6018788f5973d42e5c5142d645cc19c738227f80) | [0xde7b63f5…](https://shannon-explorer.somnia.network/tx/0xde7b63f580fe60dbc273eb182d7f71692a46520f5ba06f90e9211cacb9d41f3e) | [0x06567407…](https://shannon-explorer.somnia.network/tx/0x06567407a0ca4a899d866a7a5d44c027109bbcd493dcab2efc5cbe3f7ec8f1ea) | [0xadc50f98…](https://shannon-explorer.somnia.network/tx/0xadc50f98d810ec5cdc7157a761ad91ac0b64a793addbb8f6373c0d16a4df3e9e) | [0x60ee6684…](https://explorer.testnet.somnia.network/tokyo/tx/0x60ee6684b2f9c6bc5f2ba5865c89257d13163467aee927e729965189f5a0642d) |
| 4 | [0x10598c6a…](https://explorer.testnet.somnia.network/tokyo/tx/0x10598c6a3a70bd8d776bd7eedfb326daa12e76b51104dafbd69cc3adc9411a5a) | [0x4798736a…](https://shannon-explorer.somnia.network/tx/0x4798736a5107aa585032698d86ebb1850dc8f1c7d2e0e60f2ad72a6bd79f44f6) | [0x65315bdb…](https://shannon-explorer.somnia.network/tx/0x65315bdb87e5adfd4cc9f115fadf015cb3d80d0e86d144764d46c75be1d7eebf) | [0x54574e1f…](https://shannon-explorer.somnia.network/tx/0x54574e1f8462becb3b2bef92565ac053bd17110e43d472e4034a3139298e409a) | [0x31cf6f61…](https://explorer.testnet.somnia.network/tokyo/tx/0x31cf6f61c22ee23a1fedb69ee1e29b4f6b5dd52b6672832ea8cd3f74f482e2fe) |
| 5 | [0x794ba6c1…](https://explorer.testnet.somnia.network/tokyo/tx/0x794ba6c1fdb34b1511780845a4291586b7115fab214a29830cce0a7930292d72) | [0xb682f544…](https://shannon-explorer.somnia.network/tx/0xb682f5440e91d502e7277a920581c475676a741ae94ff1c2b73d73d3da54bbe5) | [0x0b4e7c1e…](https://shannon-explorer.somnia.network/tx/0x0b4e7c1eccbcc35dabfd51f82d53931119d1f9800bec755441e4428d78c33cd1) | [0x8d87bba8…](https://shannon-explorer.somnia.network/tx/0x8d87bba8461df53097e49952354b4354c9cb06c94818c4ffbe24cf27fd10370e) | [0x1e1c1d18…](https://explorer.testnet.somnia.network/tokyo/tx/0x1e1c1d182c909a954683c5a594987d1927eedaa2a75b1802121b50f78ea8e0aa) |
| 6 | [0x56022b58…](https://explorer.testnet.somnia.network/tokyo/tx/0x56022b587562812547c3bf1445feb5283d4c9d410e74aeed98cba4036e8ce963) | [0x6215107b…](https://shannon-explorer.somnia.network/tx/0x6215107b9b272285949055e8bff9dc0d37c0e30405cc11ead061c59b2a2cebf1) | [0xb1962562…](https://shannon-explorer.somnia.network/tx/0xb1962562b31541872d8cab7f275e9193695fce2ce81b7fe00771612a810d104f) | [0x81ed34af…](https://shannon-explorer.somnia.network/tx/0x81ed34af4015bf6d802a5c867952e8cca6c670b8b06e4e69740527b88728d807) | [0x9ced7277…](https://explorer.testnet.somnia.network/tokyo/tx/0x9ced7277c2267b96584f9e75924775d215b9a5aac5a42a50fd960756c2271f0d) |
| 7 | [0xb3756a6d…](https://explorer.testnet.somnia.network/tokyo/tx/0xb3756a6d5e937e1c576c7663044aa36c0704cb86eb2884db78a420aea891d83e) | [0x45dc4109…](https://shannon-explorer.somnia.network/tx/0x45dc4109e369b7b40407eecc07740792f05c6347fa5c01b9c2fc37a03d2ff60c) | [0xb12477da…](https://shannon-explorer.somnia.network/tx/0xb12477da2b9318dc6657f67f3b4bc7116d46608d3e7dff6d7eeed723d096b99b) | [0xa9854bcd…](https://shannon-explorer.somnia.network/tx/0xa9854bcdc2dc4b8828ef9ec2e60560af72b38c9d06c8c5d340fae0879cd40b4f) | [0x166a9fff…](https://explorer.testnet.somnia.network/tokyo/tx/0x166a9fff14fc5981a21793bb2765fd999f53ba908d14febf47d9212d24f6168c) |
| 8 | [0x403a5ada…](https://explorer.testnet.somnia.network/tokyo/tx/0x403a5ada0fac5692e4965aed9779662591607b78ccbbf0a8d50bdc1bceeaf269) | [0xeab062a9…](https://shannon-explorer.somnia.network/tx/0xeab062a97e796bc68fa3a9dfa9073523dc7da3e36bfefcda8d1cb7856939328d) | [0x69451814…](https://shannon-explorer.somnia.network/tx/0x6945181422f407b017639af09b8b23fa308e378eac58821c823fa7a66710f9dc) | [0xfeadedec…](https://shannon-explorer.somnia.network/tx/0xfeadedec4ab0afc35d4656dcf5748be5b6c52721a2a8d1b6bc1a0960b55157a6) | [0xa1d8ff86…](https://explorer.testnet.somnia.network/tokyo/tx/0xa1d8ff8691451597c45d1a718dc42e04e784d94163dc1f6c72e5729c1079e330) |
| 9 | [0xd6c2fa16…](https://explorer.testnet.somnia.network/tokyo/tx/0xd6c2fa1657f62e0becbd2704c04f34a6be2c9f9f381b49a708bf9f0c4c19eead) | [0xda1f7077…](https://shannon-explorer.somnia.network/tx/0xda1f707781c4b9c6d048d8ca9a70d35ea143c4924b5c69461d62a7a4223408ce) | [0x465cb630…](https://shannon-explorer.somnia.network/tx/0x465cb630b5e633e04fae5b9dcdf6a40f4b4f67eae3c76a8c83a50cf3124c55a0) | [0xed0d0de6…](https://shannon-explorer.somnia.network/tx/0xed0d0de6bdcb3bb20df4eb1e9a9d75828eabe6726889e1ea653998a30ca48187) | [0x49d0361f…](https://explorer.testnet.somnia.network/tokyo/tx/0x49d0361f8120d03ea13274d2d0508e257e39c302772c68950f7209c17c186001) |
| 10 | [0xefa257cd…](https://explorer.testnet.somnia.network/tokyo/tx/0xefa257cd51132a401c77b40bc3df8d3656ff1dcaeed5479a3c9be62a2e79f06c) | [0x075b5fd4…](https://shannon-explorer.somnia.network/tx/0x075b5fd45618477588a50d0f81e2aff171bdc9f015dd0b9d1ac3826d0a0242f4) | [0xc556c5e5…](https://shannon-explorer.somnia.network/tx/0xc556c5e539577407c94c489ae51f304468668e65441b96eb0a7e03def6feacb1) | [0xe7daa28e…](https://shannon-explorer.somnia.network/tx/0xe7daa28e213db732ba63f95d920c9dfe995fcfa35fbc1a3b86c3e88c5a39f7b9) | [0xd2ecbeb3…](https://explorer.testnet.somnia.network/tokyo/tx/0xd2ecbeb3eb898e1814ad49c0ed94b06a86d81a1ac0a8f6f9db2d5c865f9c92a7) |
| 11 | [0xd1829f42…](https://explorer.testnet.somnia.network/tokyo/tx/0xd1829f425ea65c0391448fe0c342ec0f720d4710daf5fb8f14a7d2b15d5e58c3) | [0x941343cc…](https://shannon-explorer.somnia.network/tx/0x941343cc67d58756d1e5d7fc3a277dbaa0d2179478de157b5ed0e9a797e70e03) | [0x0fe15abb…](https://shannon-explorer.somnia.network/tx/0x0fe15abb5d864e4140b734f02f50a22d12529b16130a2fae207a2cad3d45b4f5) | [0x975c9bcd…](https://shannon-explorer.somnia.network/tx/0x975c9bcd044c16d23eed1866da28f369a078e3ac81e016eb3b764c20755c9107) | [0x906531de…](https://explorer.testnet.somnia.network/tokyo/tx/0x906531de869fc334756eab57395345d3475bd441897d8b46bf4eceb0e2e60a51) |
| 12 | [0xb70eb5bd…](https://explorer.testnet.somnia.network/tokyo/tx/0xb70eb5bdfb398067ad8e159482e897f74e7e8f96485de86f18dff4312171c2ec) | [0x9cb2c573…](https://shannon-explorer.somnia.network/tx/0x9cb2c5733d456211243c614fcc989168bc81ec040e4047574d27b693cf0dcae0) | [0xbb51baa8…](https://shannon-explorer.somnia.network/tx/0xbb51baa8fc3887d2350155392e6bef5bddf894a475475a0582d9400f242f6300) | [0x82c418d5…](https://shannon-explorer.somnia.network/tx/0x82c418d570779fc5545ba0993cd01496afde1d3a4b97fcb2b44923c6fe9a897b) | [0xabd971fd…](https://explorer.testnet.somnia.network/tokyo/tx/0xabd971fd1cd3ffe39c7a3409c2c90ab0f7611a6500207cc875bc6d2d6f17d699) |
| 13 | [0x546746e9…](https://explorer.testnet.somnia.network/tokyo/tx/0x546746e965326d7683949bd50cce67410b32579e66dfa004e06e6edeab1b0802) | [0xb6ca36fb…](https://shannon-explorer.somnia.network/tx/0xb6ca36fba147a596075e2efc61c30bcfc1d306fd08d718830430934c39eab874) | [0x4fd94287…](https://shannon-explorer.somnia.network/tx/0x4fd94287afaa250784a5b018b05765ff44d87f1fe22f0d5b4918d018f67b4fb1) | [0x27c0c145…](https://shannon-explorer.somnia.network/tx/0x27c0c145a7e85d41c0659450625be605f8dd757e188453dab033e2974339487e) | [0x1688aa89…](https://explorer.testnet.somnia.network/tokyo/tx/0x1688aa89943e431d2a4203a63c84af01cca7dc556370b707eabaaae6d5ac4fa8) |
| 14 | [0xc613efbd…](https://explorer.testnet.somnia.network/tokyo/tx/0xc613efbd0a17ff493fc6b502545033fc6dfea5625f44af5b261ebfde51e27383) | [0xe34be5e6…](https://shannon-explorer.somnia.network/tx/0xe34be5e6213f27df9296773221f25eb0416307397d632203c96ab2c78affd86b) | [0xf09d6dc8…](https://shannon-explorer.somnia.network/tx/0xf09d6dc851f42d1d0a72fa075dc4a984258dd5aad6fd562d59de9f115fc1d4c8) | [0x3cc8a053…](https://shannon-explorer.somnia.network/tx/0x3cc8a053323b9b71fcc8fa7f34f6aa51cb1bd5a5af67e6c66877f23c280a9f38) | [0x9c925be2…](https://explorer.testnet.somnia.network/tokyo/tx/0x9c925be2c7da92f8925ac12e6fb49d946386f47ead4e3ab8f11a352caaf96d32) |
| 15 | [0xa16f0a9c…](https://explorer.testnet.somnia.network/tokyo/tx/0xa16f0a9c7acf278d6ab712029218e08033dd81d467128de868aa6cc900361ec3) | [0x0e197027…](https://shannon-explorer.somnia.network/tx/0x0e197027675fb88e596606cc22d5dcb9319426044f497bf79fe7be584fd7357b) | [0xa80cb57e…](https://shannon-explorer.somnia.network/tx/0xa80cb57ea41b7798be10a30097311114ecf6c4d027daf0a816a672605f207f1f) | [0xc5d4e402…](https://shannon-explorer.somnia.network/tx/0xc5d4e40229c76459e23992e115c1d44b46076d8241f1c109a7be9ab97702428a) | [0x53e44bac…](https://explorer.testnet.somnia.network/tokyo/tx/0x53e44bacf0c0ce70b69cb0d745956e7f73917d0d54ad4c9f7e5e4f7998d45220) |
| 16 | [0xe05096b7…](https://explorer.testnet.somnia.network/tokyo/tx/0xe05096b78421a7e434f519505373b42ea7ec836b0d7f5cf9ba9da1ab8d24ebf9) | [0xf91225fe…](https://shannon-explorer.somnia.network/tx/0xf91225fe06573094c2b50c355bca3aff85d4b9456b02cc4ea6c90d395d2b5d3d) | [0xc2c96ad4…](https://shannon-explorer.somnia.network/tx/0xc2c96ad43bd45b4f02284b5f3e5878d3eae707fbafc23cc7db2c765948a4fae2) | [0xe016d62e…](https://shannon-explorer.somnia.network/tx/0xe016d62e5cb73039689e9ca0acfa178fc5fe621c2794e20ad57d8d6dbe01dc4d) | [0xf03931c3…](https://explorer.testnet.somnia.network/tokyo/tx/0xf03931c34d057721c9880bd8917831ea0c6c4c582abeaa25537b5d99a5aec3a7) |
| 17 | [0x0e9b8a77…](https://explorer.testnet.somnia.network/tokyo/tx/0x0e9b8a772afdbb5dc367f833a2c0626b6aa9c937862e0c1202d1c3aee657c743) | [0xaec7f3a0…](https://shannon-explorer.somnia.network/tx/0xaec7f3a0c5703736b7bde973066bcbb74fdaf3b3b9c32c19a798184c9c39faed) | [0xce6a9715…](https://shannon-explorer.somnia.network/tx/0xce6a97156a1fc0864c47703d07d943aa6d53adb222ad8031e482042a5bdf530d) | [0xdd979f89…](https://shannon-explorer.somnia.network/tx/0xdd979f89f3812cef9fc622a360f7adeb355501be7f6c6fa997fc1907bd35a167) | [0xb3541bc5…](https://explorer.testnet.somnia.network/tokyo/tx/0xb3541bc5ac8d67dbc450b380c0039ad1484e4a12a259151355779be114b6439b) |
| 18 | [0xccecf9db…](https://explorer.testnet.somnia.network/tokyo/tx/0xccecf9db2f971ddd1b55b536b5f3521513378c98f0cb739b95d5796a2276cfc0) | [0x8f205866…](https://shannon-explorer.somnia.network/tx/0x8f20586600332b4d84ecbea6c1bb400f07ad3fb1df21e80a6c4a03278bf0b754) | [0x724f6f1c…](https://shannon-explorer.somnia.network/tx/0x724f6f1c436d901fc9725325b1be7a6e8d0020d484dcfa718251082bcddae7b8) | [0x62390b77…](https://shannon-explorer.somnia.network/tx/0x62390b77f960c16e398ee4cf8c8103f8b32bc923b832cd0a98a474e93ea04df3) | [0x24d88251…](https://explorer.testnet.somnia.network/tokyo/tx/0x24d8825157949e388a355da9b9a01c4c0df184de776e6d0ed3a993f2572f9dec) |
| 19 | [0xf0a188c0…](https://explorer.testnet.somnia.network/tokyo/tx/0xf0a188c043d85823849e98019ffee66b71fed66a407f7a7f3b5828484bb3bb9a) | [0x886ea4e5…](https://shannon-explorer.somnia.network/tx/0x886ea4e5c93d78ea0d0eceb2c2be52315db488afe05aed375bf9627a434544b2) | [0x841591f2…](https://shannon-explorer.somnia.network/tx/0x841591f26728f9ffd115a3ec1d8401cb91cd7480dc0ced26a8bcb7f4169ef4fd) | [0xe170bf41…](https://shannon-explorer.somnia.network/tx/0xe170bf419a5e776f697b6929315ba68480f2f354e191a06e17f309c1ad422573) | [0x84a1629a…](https://explorer.testnet.somnia.network/tokyo/tx/0x84a1629a8fdced645cabb9bd5472f75dacb0b15b321562a77e127b4f5615f082) |
| 20 | [0x4b0eda3e…](https://explorer.testnet.somnia.network/tokyo/tx/0x4b0eda3e6a3231321ad93063170dac9f89ea9e67c48b23897c9d3e549e29f1c9) | [0x8b4fd96d…](https://shannon-explorer.somnia.network/tx/0x8b4fd96dd3820483ea15c9fb83809c637edf2927eabfeb0157485fcedb034a63) | [0x79833c94…](https://shannon-explorer.somnia.network/tx/0x79833c94eabb0cca12d2e3f68e13cdcdcde14a36fed10925f15ce43134fd0a8e) | [0x7d90b25b…](https://shannon-explorer.somnia.network/tx/0x7d90b25b145600032aef4eabde5376ea1abb29049232066b8d775dfd6e92275b) | [0x38c4a22e…](https://explorer.testnet.somnia.network/tokyo/tx/0x38c4a22e487a66c2e8897d512bb607fbede6b3fa1fc13aac625060f4ea603f0e) |

### Validators

Four validators served these requests, three per request. In the summary stage, all three returned identical bytes on
every review. In the verdict stage, the three answers were also identical on every review.

| validator | summary fetches | LLM answers | answers matching the rubric |
|---|---|---|---|
| `0x05f1fE2DDF9B65576D3165E37C6A60e6c5Ba93De` | 19 | 18 | 12 |
| `0x3E05e29029C60E000C8F01EB5AC9cEE6b242D7e0` | 15 | 16 | 11 |
| `0x1Cb38b3ee632B5dCc0347dB81766606d6Aad4926` | 15 | 14 | 9 |
| `0x55Acbe370872c7D90F504eF169217a00c29E2A33` | 11 | 12 | 10 |

## Reading the misses

- **Liquidations: 10 of 10.** The committee applies both liquidation rules: every trader with 2 or more liquidations
  was BLOCKed and every trader with exactly 1 got CAUTION. That held for heavy and light traders and for profitable
  and losing ones. It also held with fewer than 10 trades (rows 7, 9, 10).
- **Thin history: 0 of 3.** `trades30d < 10` is the only rule that fires for rows 17 to 19 (3, 7 and 5 trades, no
  liquidations), and the committee answered OK each time. The thin-data rule is ignored when nothing else is wrong.
- **False BLOCKs: 3.** All three are traders with no liquidations and no drawdown percentage:
  - row 1: 113 trades, +3,773.3;
  - row 14: 15 trades, −464.9;
  - row 13: `partial=1`, +25.6.

  Summaries just like them were rated OK correctly:
  - row 16: 127 trades, −1,018.8, with a larger absolute drawdown than row 14;
  - row 15;
  - the leader.

  No single key in the summary separates the false BLOCKs from the correct OKs.
- **`partial=1`: 1 of 2.**
- **Repeatable, not noisy.** Within each committee all three validators gave the same word, which fits the platform's
  deterministic inference. A committee of three therefore confirms one model output; it does not give three
  independent opinions. The steady trader of row 1 got BLOCK from the same summary bytes under both the first prompt
  and this one.

The gate acts on BLOCK only (`allowIncrease` refuses a guarded follower's increase for a BLOCK younger than 7 days).
Confusing OK with CAUTION therefore changes nothing a follower can do, but a false BLOCK stops a follower from adding
to a trader the policy would allow.

## The first prompt

The reviewer launched with this prompt:

> You review perpetual-futures traders for people who copy their positions automatically. Read the 30-day stats
> (key=value). n/a means unknown, not safe. partial=1 means only the most recent activity was read. history=none means
> no trades. Answer with exactly one word: BLOCK if a follower copying this trader is likely to be wiped out (repeated
> liquidations or a drawdown near or above the margin), CAUTION if risk is elevated or the data is too thin to judge,
> OK otherwise.

Its first three live reviews were all BLOCK, 3 votes of 3 each
(see [`deployments/risk.json`](../deployments/risk.json), nonces 1 to 3):

| trader | summary | first prompt | rubric |
|---|---|---|---|
| steady `0xfc2F…7fd2` | 113 trades, **+3,773.3** realized, **0 liquidations**, drawdown 679.3 | BLOCK | OK |
| liquidated `0xA14d…3D14` | 3 liquidations, drawdown 92.2% | BLOCK | BLOCK |
| leader `0xA1d0…7b5d` | 42 trades, −0.2, 0 liquidations, drawdown 0.2 | BLOCK | OK |

The first prompt asked whether the drawdown was "near or above the margin", but the summary has no margin to compare
against:
- `maxDrawdown30d` is an absolute amount in quote units;
- `maxDrawdownPct30d`, the only figure relative to margin, appears only when leverage settings cover at least half of
  the trading.

The prompt also called every n/a "not safe", and `avgLeverage=n/a` is in almost every summary. With no baseline, a
four-figure drawdown reads as a wipe-out, and so does an unknown leverage. A profitable trader with no liquidations
was blocked.

The rubric drops "near the margin" and names exact keys and thresholds. On the same three traders it now agrees on two
(the liquidated trader is BLOCK and the leader is OK). The steady trader is still BLOCKed (row 1).

## What the gate holds now

- **BLOCK, 9 traders.** Rows 1–7, 13 and 14 hold a BLOCK, 3 of them false. A BLOCK lasts 7 days. A milder verdict
  can replace it once it is 24 hours old.
- **The leader.** Its OK arrived within 24 hours of its first-run BLOCK, so the gate kept the BLOCK (`BlockHeld`), as
  designed. That BLOCK can be replaced after 13:36:31 UTC on 2026-10-29.
- **CAUTION and OK.** The other traders hold CAUTION or OK, and neither restricts anyone.

## Cost and latency

- **Reviewer deposits:** 4.3387 STT for 20 reviews, 0.2169 STT each. The reviewer went from 11.3534 to 7.0147 STT.
  The committees used 0.0003 STT per validator to fetch the summary and 0.07 STT per validator to classify it. The
  platform returns the unused part of each deposit.
- **Review fees:** 20 × 0.5 STT, paid to the gate. The gate now holds 11.5 STT, which the owner can withdraw.
- **Gas:**
  - `requestReview` on Hideki: 194,592 – 407,983;
  - `setSystemPrompt`: 208,877;
  - the anchor: 29,320.
- **Latency,** from the request to the verdict landing on Hideki (block timestamps): median 14.5 s, range 9 – 26 s.

## Limitations

- **The Hyperlane lane is a dev lane.** Both directions run through the testnet lane, and each side's ISM has a single
  validator (the same key on both). Whoever holds that key could deliver a forged verdict, a BLOCK included. The
  committee's work is verifiable on Shannon, but the Hideki gate trusts the lane.
- **The platform's per-response `receipt` field is 0** in every response here. What the validators actually signed is
  the callback transactions above and the responses they carry, decoded in `results.json`.
- **LLM output depends on the prompt.** Each trader was reviewed once. The three validators always agreed, but the
  answer depends on the exact prompt and summary bytes, and a trader whose summary changes can get a different answer.
  Twenty reviews is a small sample.
- **Some rules were barely tested.** `maxDrawdownPct30d` appears in only one summary (92.2%, already BLOCK for its
  liquidations), so the 25% and 50% drawdown thresholds were not tested on their own. No screened trader had
  `history=none`.
- **The rubric is public.** It is a published policy that the validators apply, not a secret model. A trader can read
  the thresholds; the value is in applying the policy where anyone can check it. Each verdict carries the hash of the
  summary it judged, and the rubric is mechanical, so anyone can recompute the expected tier. This scorecard was built
  that way.
- **The data comes from our endpoint.** The JSON committee attests that its members fetched identical bytes from it,
  not that those bytes are true. The summary is computed from the dreamDEX indexer with a 2,000-row cap
  (`partial=1` beyond it).

## Reproduce

```sh
cd e2e
npm run eval:test                                      # the rubric's unit tests
COPYBOOK_ENV=keys.env npm run eval select              # sample + eval/answer-key.json
COPYBOOK_ENV=keys.env npm run risk prompt              # reviewer.setSystemPrompt(rubric)
COPYBOOK_ENV=keys.env npm run risk review <trader>     # one paid review, followed on both chains
npm run eval score                                     # eval/results.json and the tables above
```

To check the pre-registration, run `git show 6b1b074:eval/answer-key.json` and hash the output with keccak256. The
result must equal the last 32 bytes of the anchor transaction's input.
