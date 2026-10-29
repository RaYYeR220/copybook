# Risk review scorecard

Copybook's AI guard is a committee of Somnia validators. The `RiskReviewer` on Shannon has one committee fetch a
trader's 30-day risk line from our public endpoint and another classify it as OK, CAUTION or BLOCK. The verdict
travels over Hyperlane to the `RiskGate` on Hideki, and the hub then refuses new size to guarded followers of a
BLOCKed trader.

This page measures how faithfully the live committee applies a published rubric to real Hideki traders. For runs v2,
v3 and v4 we wrote down the expected answer for every trader and committed it before requesting a single review, and
wrote the commit on chain. Run v1, three reviews under the launch prompt, was scored against the rubric afterwards.
The scorecard compares the committee's verdicts with the answer key.

**Latest result (run v4, held out): 19 of 20 verdicts match the rubric on 20 traders no earlier run had seen.**
- **The setup was run v3's, unchanged:** the rubric, the prompt, the endpoint's line, the reviewer and the scorer.
- **BLOCK recall: 7 of 8.** One trader with 10 liquidations got CAUTION, 3 votes of 3, where the rubric says BLOCK.
  The gate stores that CAUTION, so guarded followers of that trader are not protected until a new review.
- **No false BLOCKs.** The committee blocked none of the 12 traders the rubric does not block.
- **Thin history and `partial=1`:** CAUTION, as the rubric says.
- **Failures:** no review failed, and every committee answered unanimously.

**Run v3, on the 20 traders its changes were chosen on: 18 of 20, with no missed and no false BLOCK.** The four earlier
false BLOCKs that run v3 left held on the gate were replaced by fresh reviews on 2026-10-29 (see
[what the gate holds](#what-the-gate-holds-now)).

## Four runs

| run | what the model is given | traders | tiers matching the rubric | BLOCK / not-BLOCK agreement | BLOCK recall | false BLOCKs |
|---|---|---|---|---|---|---|
| [v1](#run-v1-the-first-prompt) | the first prompt (no rubric) and the full summary, in the user prompt | 3, scored afterwards | 1 of 3 | 1 of 3 | 1 of 1 | 2 of 2 |
| [v2](#run-v2-the-rubric-in-the-user-prompt-with-the-full-summary) | the rubric and the full summary, in the user prompt | 20, pre-registered | 14 of 20 | 17 of 20 | 6 of 6 | 3 of 14 |
| [v3](#run-v3-the-rubric-as-the-system-message-and-only-the-keys-it-reads) | the rubric as the system message; only the rubric's keys in the user prompt | the same 20, pre-registered again | 18 of 20 | 20 of 20 | 6 of 6 | 0 of 14 |
| [v4](#run-v4-held-out-20-fresh-traders) | as in run v3, unchanged | 20 fresh traders, pre-registered (held out) | 19 of 20 | 19 of 20 | 7 of 8 | 0 of 12 |

"BLOCK / not-BLOCK agreement" counts the traders whose committee verdict falls on the same side of the gate's line as
the rubric's tier: BLOCK (refuse new size) or not BLOCK (allow it). It is the gate decision the verdicts imply. The live
gate keeps an older BLOCK against a milder verdict for its first 24 hours, and an unreplaced BLOCK blocks for 7 days,
so what the gate does can differ (see [what the gate holds](#what-the-gate-holds-now)).

## The rubric

The rubric is published in [`rubric.ts`](rubric.ts), which also applies it in code. It reads the keys of the line the
committee classifies (the full summary in runs v1 and v2, the rubric line in runs v3 and v4), and n/a means unknown,
not safe.

- **BLOCK** if `liquidations30d >= 2`, or `maxDrawdownPct30d` is present and `>= 50`.
- **CAUTION** if the trader is not BLOCKed and any of these holds:
  - `liquidations30d == 1`
  - `trades30d < 10`
  - `history=none`
  - `partial=1`
  - `maxDrawdownPct30d` is present and `>= 25`
- **OK** otherwise.

The rubric's logic in `rubric.ts` is unchanged since the anchored commits. Only a comment was corrected later, and
`git diff 5aed53b HEAD -- eval/rubric.ts` shows it.

Runs v2, v3 and v4 use the same system prompt, which states the rule in words. The runs differ in how this text and the
trader's data reach the LLM agent.

> You review perpetual-futures traders for people who copy their positions automatically. Apply this rubric exactly to
> the 30-day stats (key=value; n/a means unknown, not safe). BLOCK if liquidations30d is 2 or more, or
> maxDrawdownPct30d is present and at least 50. Otherwise CAUTION if liquidations30d is 1, or trades30d is below 10,
> or history=none, or partial=1, or maxDrawdownPct30d is present and at least 25. Otherwise OK. Answer with exactly one
> word: OK, CAUTION or BLOCK.

## Run v4: held out, 20 fresh traders

### What is held out

Run v3's changes were chosen after reading run v2's errors on the same 20 traders. Run v4 asks the question run v3
could not answer: does the same setup hold on traders it has never seen?

- **Fresh traders.** None of the 20 was reviewed in runs v1 to v3 or screened for run v2's sample. None is one of our
  own wallets.
- **Nothing else changed.** These are run v3's, unchanged:
  - the rubric (the code of [`rubric.ts`](rubric.ts));
  - the system prompt and the endpoint's `rubric` line;
  - the reviewer [`0xc999…7c25`](https://shannon-explorer.somnia.network/address/0xc999B6924179a0dc9649DA7eBa8F3aC8b7CF7c25)
    and its settings;
  - the scorer, `e2e/src/eval.ts`.
- **How this was checked before the sample was drawn:**
  - **On chain.** At 22:39:03 UTC the reviewer's field (`rubric`), system prompt, base URL and agents were read from the
    chain. Each matched run v3's, and the gate and the reviewer still pointed at each other.
  - **In the repository.** `eval.ts` is the same git blob (`a518a66`) as at run v3's pre-registration (`5aed53b`).
    `rubric.ts` differs from it only in a comment.
  - **At the endpoint.** The `rubric` line it served for three run-v3 traders matched one computed locally from the
    same code.
- **How it was scored.** [`eval-v4.ts`](../e2e/src/eval-v4.ts) runs `eval.ts score v3` unchanged, in a scratch copy of
  the tree that holds run v4's key in place of run v3's. Pointed at run v3's own key, the same wrapper reproduces
  [`v3/results.json`](v3/results.json) exactly, apart from the time it was scored.

### Sampling

The rule was committed (`dfceabc`) before the sample was drawn, and it is recorded in
[`v4/answer-key.json`](v4/answer-key.json) with every account screened:

- **Exclusions.** The rule leaves out 77 accounts:
  - every trader reviewed in runs v1 to v3;
  - every account in run v2's key (its 20 traders and all 59 screened accounts);
  - our demo wallets (`deployments/hideki.json`), our contracts, and the wallets of our own keys.
- **Pools.** The pools are run v2's, without its first-live-run pool, each read in a fixed order from the dreamDEX
  indexer over the last 30 days:

  | # | pool | target stratum | accounts |
  |---|---|---|---|
  | 1 | 2+ liquidations in the latest 1000 liquidation rows | liquidated-2+ | 59 |
  | 2 | 1 liquidation in the latest 1000 liquidation rows | liquidated-1 | 220 |
  | 3 | fewest rows in the latest 1000 position changes | thin | 48 |
  | 4 | largest single realized gains | clean | 25 |
  | 5 | latest position changes | clean | 48 |

- **Taking a trader.** Each account is screened with `packages/stats` over the endpoint's 2,000-row cap. It is taken
  when the quota of the stratum it falls in is still open. The quotas are runs v2 and v3's, with the leader's place
  moved to the clean stratum:
  - 6 with 2 or more liquidations;
  - 4 with exactly one;
  - 3 thin (fewer than 10 trades);
  - 7 clean.
- **The fallback.** If a quota is still open after the pools, its places go to the screened accounts not taken, in
  screening order, whatever their stratum.

**What happened.** 53 accounts were screened.
- **Thin stratum short by 2.** The thin pool was read to its end and held only one thin trader; most of its accounts
  had 10 or more trades. The fallback therefore filled the two open places with the first accounts screened but not
  taken, which both had 2+ liquidations.
- **The sample:** 8 traders with 2+ liquidations, 4 with exactly one, 1 thin and 7 clean. One of the clean traders is
  a high-frequency account with `partial=1`.
- **Expected tiers:** 8 BLOCK, 6 CAUTION, 6 OK.

### Pre-registration of run v4

| step | when (UTC, 2026-10-29) | evidence |
|---|---|---|
| sampling rule and tooling committed | 22:38:43 | commit `dfceabc` |
| reviewer settings read from the chain | 22:39:03 | `frozen` in [`v4/answer-key.json`](v4/answer-key.json) |
| rubric lines fetched from the public endpoint | 22:41:07 – 22:41:57 | `fetchedAt` per trader, all fresh (cache miss) |
| answer key committed | 22:42:44 | commit `a7c42c247a038b65d502826df7dc703a4cdcaa9a` |
| commit hash and key hash written on chain | 22:43:34 | [Hideki tx 0xadd80abe…](https://explorer.testnet.somnia.network/tokyo/tx/0xadd80abe7fdd825fe6f4086d62b09c44f50d2aeb2519b0479462e0a14be06b09) (block 36,605,996), recorded in [`v4/anchor.json`](v4/anchor.json) |
| first review requested | 22:44:02 | row 1 below |
| last verdict delivered to Hideki | 22:51:00 | row 20 below |

The anchor carries the commit hash followed by the keccak256 of `eval/v4/answer-key.json` as committed
(`0x8cbca4b63fd467637337b29518b003ed4e0ff998f93bf1d93764224363782287`). This run's reviews have nonces 48 to 67 on the
gate. The reviewer's settings read the same after the run as before it.

### Run v4 result

**19 of 20 verdicts match the rubric. The committee's verdicts imply the right gate decision for 19 of 20.**
- **BLOCK recall:** 7 of 8. One trader the rubric blocks got CAUTION (row 6).
- **False BLOCKs:** none, out of 12 traders the rubric does not block.
- **Thin history and `partial=1`:** CAUTION, as the rubric says (1 of 1 each).
- **Failures:** none. Every committee answered unanimously, and 57 of 60 validator answers match the rubric.
- **Summary hashes:** all 20 lines the committee agreed on are byte-identical to the key. The JSON stage returned the
  same bytes from all 3 validators every time.
- **Requests:** all 20 inference requests were the published prompt and line.

| expected \ committee | OK | CAUTION | BLOCK | no verdict |
|---|---|---|---|---|
| **OK** | **6** | 0 | 0 | 0 |
| **CAUTION** | 0 | **6** | 0 | 0 |
| **BLOCK** | 0 | 1 | **7** | 0 |

### Run v4 per trader

**Rule inputs** come from the line the committee saw. A tier in bold disagrees with the rubric.

| # | trader | picked as | rule inputs seen | seen = key | expected | committee (OK/CAU/BLK) | gate |
|---|---|---|---|---|---|---|---|
| 1 | [`0xbbD7…C50A`](https://explorer.testnet.somnia.network/tokyo/address/0xbbD7Bd1984D2Dec78bAdfA1b97F9dd71C58AC50A) | liquidated-2+ | liq 135 · trades 245 | yes | BLOCK | BLOCK (0/0/3) | VerdictReceived BLOCK |
| 2 | [`0x8b2e…c6B4`](https://explorer.testnet.somnia.network/tokyo/address/0x8b2e23fF6ae00bB2122B4270Dec9cfd0E3FAc6B4) | liquidated-2+ | liq 14 · trades 160 | yes | BLOCK | BLOCK (0/0/3) | VerdictReceived BLOCK |
| 3 | [`0x6F8c…36F7`](https://explorer.testnet.somnia.network/tokyo/address/0x6F8c34D620007cC828ea5463bd9FCc22E95836F7) | liquidated-2+ | liq 12 · trades 26 | yes | BLOCK | BLOCK (0/0/3) | VerdictReceived BLOCK |
| 4 | [`0xBF9d…2b2E`](https://explorer.testnet.somnia.network/tokyo/address/0xBF9dE4B042765dF49702754eb750b861b4432b2E) | liquidated-2+ | liq 15 · trades 126 | yes | BLOCK | BLOCK (0/0/3) | VerdictReceived BLOCK |
| 5 | [`0x7eCA…81FF`](https://explorer.testnet.somnia.network/tokyo/address/0x7eCA608ab206d5763459eA3eB0133933a6aC81FF) | liquidated-2+ | liq 11 · trades 91 | yes | BLOCK | BLOCK (0/0/3) | VerdictReceived BLOCK |
| 6 | [`0x6D73…6b1e`](https://explorer.testnet.somnia.network/tokyo/address/0x6D73E0A82aE20EE0C0de7E9061369a9E3c9f6b1e) | liquidated-2+ | liq 10 · trades 27 | yes | BLOCK | **CAUTION** (0/3/0) | VerdictReceived CAUTION |
| 7 | [`0xF57A…DeFe`](https://explorer.testnet.somnia.network/tokyo/address/0xF57A291a0366143e184bFD7A86244d1d9feCDeFe) | liquidated-1 | liq 1 · trades 25 | yes | CAUTION | CAUTION (0/3/0) | VerdictReceived CAUTION |
| 8 | [`0x23db…6823`](https://explorer.testnet.somnia.network/tokyo/address/0x23db970515C7d7ad2D553574Ef7f4a4cDD496823) | liquidated-1 | liq 1 · trades 79 | yes | CAUTION | CAUTION (0/3/0) | VerdictReceived CAUTION |
| 9 | [`0xFD89…54A5`](https://explorer.testnet.somnia.network/tokyo/address/0xFD891304E3F6f6Ffd8e928F402708282f4c254A5) | liquidated-1 | liq 1 · trades 44 | yes | CAUTION | CAUTION (0/3/0) | VerdictReceived CAUTION |
| 10 | [`0x7E82…9Ec5`](https://explorer.testnet.somnia.network/tokyo/address/0x7E820809898Bce669A3A8Cf50e406651750a9Ec5) | liquidated-1 | liq 1 · trades 1206 | yes | CAUTION | CAUTION (0/3/0) | VerdictReceived CAUTION |
| 11 | [`0xaf0D…1d75`](https://explorer.testnet.somnia.network/tokyo/address/0xaf0D8dC490406aA41cf9563C5D5f3e4f132e1d75) | clean | liq 0 · trades 1409 | yes | OK | OK (3/0/0) | VerdictReceived OK |
| 12 | [`0x44F4…3e06`](https://explorer.testnet.somnia.network/tokyo/address/0x44F49964F9e0491d1BB083a8230C101B18Cd3e06) | clean | liq 0 · trades 35 | yes | OK | OK (3/0/0) | VerdictReceived OK |
| 13 | [`0x7383…40b0`](https://explorer.testnet.somnia.network/tokyo/address/0x7383ae1664cdbB8359B2EbBD0eebdba2E91b40b0) | clean | liq 0 · trades 33 | yes | OK | OK (3/0/0) | VerdictReceived OK |
| 14 | [`0x716D…D605`](https://explorer.testnet.somnia.network/tokyo/address/0x716D25FA3a3cBd2854022db424811464fa91D605) | clean | liq 0 · trades 154 | yes | OK | OK (3/0/0) | VerdictReceived OK |
| 15 | [`0x1aB4…61f8`](https://explorer.testnet.somnia.network/tokyo/address/0x1aB43A002bEEEA905F938Ca9E24d9BcC43Ad61f8) | clean | liq 0 · trades 2000 · partial=1 | yes | CAUTION | CAUTION (0/3/0) | VerdictReceived CAUTION |
| 16 | [`0xB61f…05D1`](https://explorer.testnet.somnia.network/tokyo/address/0xB61f13A44c3E83946A39861D2b67F8b6050a05D1) | clean | liq 0 · trades 59 | yes | OK | OK (3/0/0) | VerdictReceived OK |
| 17 | [`0x4680…2184`](https://explorer.testnet.somnia.network/tokyo/address/0x4680a54939F915cf0F3e4653755FbB2D1Dc52184) | clean | liq 0 · trades 38 | yes | OK | OK (3/0/0) | VerdictReceived OK |
| 18 | [`0x518E…9A18`](https://explorer.testnet.somnia.network/tokyo/address/0x518EB8ee6D091F74D673B6331b65ab5318B39A18) | thin | liq 0 · trades 4 | yes | CAUTION | CAUTION (0/3/0) | VerdictReceived CAUTION |
| 19 | [`0x9e18…3495`](https://explorer.testnet.somnia.network/tokyo/address/0x9e18c49EfC49ac55D9F7E4c4aDa469Aef4073495) | liquidated-2+ | liq 4 · trades 367 | yes | BLOCK | BLOCK (0/0/3) | VerdictReceived BLOCK |
| 20 | [`0xC1DA…f5b1`](https://explorer.testnet.somnia.network/tokyo/address/0xC1DA1F512528b0b77C5fF199904951B7B9Dcf5b1) | liquidated-2+ | liq 2 · trades 298 | yes | BLOCK | BLOCK (0/0/3) | VerdictReceived BLOCK |

<details><summary>Lines the committee saw (from each review's <code>SummaryReceived</code> event)</summary>

| # | rubric line |
|---|---|
| 1 | `liquidations30d=135 trades30d=245 history=yes partial=0` |
| 2 | `liquidations30d=14 trades30d=160 history=yes partial=0` |
| 3 | `liquidations30d=12 trades30d=26 history=yes partial=0` |
| 4 | `liquidations30d=15 trades30d=126 history=yes partial=0` |
| 5 | `liquidations30d=11 trades30d=91 history=yes partial=0` |
| 6 | `liquidations30d=10 trades30d=27 history=yes partial=0` |
| 7 | `liquidations30d=1 trades30d=25 history=yes partial=0` |
| 8 | `liquidations30d=1 trades30d=79 history=yes partial=0` |
| 9 | `liquidations30d=1 trades30d=44 history=yes partial=0` |
| 10 | `liquidations30d=1 trades30d=1206 history=yes partial=0` |
| 11 | `liquidations30d=0 trades30d=1409 history=yes partial=0` |
| 12 | `liquidations30d=0 trades30d=35 history=yes partial=0` |
| 13 | `liquidations30d=0 trades30d=33 history=yes partial=0` |
| 14 | `liquidations30d=0 trades30d=154 history=yes partial=0` |
| 15 | `liquidations30d=0 trades30d=2000 history=yes partial=1` |
| 16 | `liquidations30d=0 trades30d=59 history=yes partial=0` |
| 17 | `liquidations30d=0 trades30d=38 history=yes partial=0` |
| 18 | `liquidations30d=0 trades30d=4 history=yes partial=0` |
| 19 | `liquidations30d=4 trades30d=367 history=yes partial=0` |
| 20 | `liquidations30d=2 trades30d=298 history=yes partial=0` |

</details>

#### Run v4 transactions

| # | Hideki: requestReview | Shannon: summary request | Shannon: verdict request | Shannon: verdict | Hideki: verdict delivered |
|---|---|---|---|---|---|
| 1 | [0xb79030ad…](https://explorer.testnet.somnia.network/tokyo/tx/0xb79030ad48734fdd37da80329fa8d97800e96bf336fcafca9f627b077ec57c7f) | [0x5337408d…](https://shannon-explorer.somnia.network/tx/0x5337408d7ffa7e274c8f264994dfcb97e6ea6864db6c0a538b66b92aa03a26c0) | [0x878a8df2…](https://shannon-explorer.somnia.network/tx/0x878a8df236bda56f7112bef212a5cf2faa89c11d6f2afa1bebeca41d313577d6) | [0x870b1fef…](https://shannon-explorer.somnia.network/tx/0x870b1fef8bda5271b46066ce01b355c6697dc871997e35da31de2f292ea97d6a) | [0xa4d146a2…](https://explorer.testnet.somnia.network/tokyo/tx/0xa4d146a28ce0ebb903f3c5deff17b57143eb72aa9aa02fa20d2e4b52fdf5b535) |
| 2 | [0x60d9d7da…](https://explorer.testnet.somnia.network/tokyo/tx/0x60d9d7da365b00eda3d5f267a1323fa30fcebec10c83dcbf3c909c05f12f5e7e) | [0xa3a92026…](https://shannon-explorer.somnia.network/tx/0xa3a9202631074c76cb9d68df2d5c77c40acfb292e24dfa1e8b20e2f782257c29) | [0x21e97ae8…](https://shannon-explorer.somnia.network/tx/0x21e97ae8a7997d83895407355fc7749b2411d054d2c740b7358651a34259cb5b) | [0xba1a577a…](https://shannon-explorer.somnia.network/tx/0xba1a577a20534316521e49fa0f448afa46866fc6d9720187e48e51f862291b22) | [0x85537b08…](https://explorer.testnet.somnia.network/tokyo/tx/0x85537b08a0bf7e955fd86cf152a08a9f7d89797facc9198daa4a1c1677734126) |
| 3 | [0x82516831…](https://explorer.testnet.somnia.network/tokyo/tx/0x82516831b44bb1805400300866cf01705cb6d8062cd14a03a7b8a326e4c02aa2) | [0x755d75ae…](https://shannon-explorer.somnia.network/tx/0x755d75ae075678a997f1e64945d32ce514cf09c08249ec877bc40a30c16dde3b) | [0xf4285874…](https://shannon-explorer.somnia.network/tx/0xf42858746d3f30661f7b1e6003b9900bd510e9af484ca690cd7c4d96f205ad7f) | [0x5e1ab403…](https://shannon-explorer.somnia.network/tx/0x5e1ab403378fde583e325cd6ec6c9adcd6ca05c6472943c9030f0da43ae3294a) | [0x9fa4c8d2…](https://explorer.testnet.somnia.network/tokyo/tx/0x9fa4c8d226d5e459bb08acda89281c7034b7d9dca9ec4c854459efd8f05d30d3) |
| 4 | [0x6a0cf815…](https://explorer.testnet.somnia.network/tokyo/tx/0x6a0cf815cd923643f89005acd72f8a87352a86f3a8deacf5d71e4f460fe6197b) | [0xeed3f724…](https://shannon-explorer.somnia.network/tx/0xeed3f72442f67d1ca7cedb9755726bef2cf9e99103ae9374ea8b66f43ee1d411) | [0x1b365089…](https://shannon-explorer.somnia.network/tx/0x1b365089693ff190aaf728e7217acd2421963ce3ff7a0fd8efffbc1c4d0fb655) | [0x5fa6a823…](https://shannon-explorer.somnia.network/tx/0x5fa6a82356574383162f9fae1f784475e6eb13a5805337401fee1930d8e837f8) | [0x989d46ed…](https://explorer.testnet.somnia.network/tokyo/tx/0x989d46ed32beb405c6074998a2af5861ddf7d26d30dbe2671ba1aa9ee039fbe6) |
| 5 | [0xc35b6450…](https://explorer.testnet.somnia.network/tokyo/tx/0xc35b64500a7564ec90f674560034c6410046bd7e75f8a8854fa593b1f1a4caf6) | [0xe02d5ad4…](https://shannon-explorer.somnia.network/tx/0xe02d5ad41d1ad7fb1bc133978b5306b3735aab62e5d4e5a4951d51fd09e8871c) | [0xea3e78c9…](https://shannon-explorer.somnia.network/tx/0xea3e78c90f00adb1e8e555f2c88f8ca79703c48a26b549a15b0c301c1d387023) | [0x58899a1d…](https://shannon-explorer.somnia.network/tx/0x58899a1df1ad95bf22e936d2a381b4b4bfa8d67dacce87fed949e87a05be52f5) | [0x82e55330…](https://explorer.testnet.somnia.network/tokyo/tx/0x82e5533095c33aa4cec46b405069de7a3636e543a7e116e6c505102bf0585f1b) |
| 6 | [0x138510fa…](https://explorer.testnet.somnia.network/tokyo/tx/0x138510fad9ae58101f0b03ef82b422250ee81f6a9769a490f6975b0160d6125b) | [0x288ba9f7…](https://shannon-explorer.somnia.network/tx/0x288ba9f7fca29069ea8d1037f4c88dcfc4995654b003fddf29cd38c010d2c537) | [0xd87ce07e…](https://shannon-explorer.somnia.network/tx/0xd87ce07e1898ca79fa6dd5b2663a897f87b26eaab547bf19c3b40c9d8fc796fc) | [0xa9bdac8a…](https://shannon-explorer.somnia.network/tx/0xa9bdac8a619c5aaf3d1b458dad1ea83784b26faf0d8f55d18ed4759eb8acece2) | [0x694bb68c…](https://explorer.testnet.somnia.network/tokyo/tx/0x694bb68c33fce2f481372e62fbcf881caa0e14fd57e7f1251e960ce13dfa1d58) |
| 7 | [0xc71501e2…](https://explorer.testnet.somnia.network/tokyo/tx/0xc71501e262933056b41c89de2eb98b96e2e607ecbb1b81c900ae332470151b36) | [0x8269add6…](https://shannon-explorer.somnia.network/tx/0x8269add662595f12fa0f5978ce2390ba487378d2683e6e7754545209a079ff45) | [0xc5510261…](https://shannon-explorer.somnia.network/tx/0xc55102613205f31c82085e024c4c2026da7fd5e4e8fd5c1cf884072e6d5fa53c) | [0x0d95e30b…](https://shannon-explorer.somnia.network/tx/0x0d95e30b2773cbbd9d18c079dd9720155549a8e5ebbfefcf7f1147c68c5147d4) | [0x0445dcbc…](https://explorer.testnet.somnia.network/tokyo/tx/0x0445dcbc6c9cfbae5995be0f78fd75438d498c713f4102ee6c902a619ed515e8) |
| 8 | [0xd8f76ec4…](https://explorer.testnet.somnia.network/tokyo/tx/0xd8f76ec44c421f590d183e7cf225e7772f9b8196b17417686f110c1659bb7b03) | [0xa1cbfbe2…](https://shannon-explorer.somnia.network/tx/0xa1cbfbe22cdf29ec56bfd1e3162cc6d1914eb7381aa30036ffe98861eb70653c) | [0xda56c46c…](https://shannon-explorer.somnia.network/tx/0xda56c46c4a023ab2dc3794be846aa3421f04573a0ae1493d4836b94e4bb75bcc) | [0x024392de…](https://shannon-explorer.somnia.network/tx/0x024392de788c8b189c40b44333facfce80b1050797e63f377f5634ec18e57a1f) | [0xd0e08df8…](https://explorer.testnet.somnia.network/tokyo/tx/0xd0e08df8b428759d0c9724b8e7daba49b099a9f1f6f8e2d6ba9421c3ba1e281b) |
| 9 | [0x91337c9a…](https://explorer.testnet.somnia.network/tokyo/tx/0x91337c9a3ed59cc59038cf1f3eb375f3add23a2cb9c776f22d60a90675fd7ccb) | [0xd117b30c…](https://shannon-explorer.somnia.network/tx/0xd117b30c9e04b2fe1e1143816851ba6a9bffdff33a71dbfd33d845631d6a3924) | [0x2c4d8b19…](https://shannon-explorer.somnia.network/tx/0x2c4d8b1969f69536bb5fbec5739c062637a2af87f5bff09301edc8246a6acb85) | [0x230d9a59…](https://shannon-explorer.somnia.network/tx/0x230d9a59f4a2ea32a4194bec69e6c24c9fac28ad8f3108e3808c5162b79a2851) | [0xaba89023…](https://explorer.testnet.somnia.network/tokyo/tx/0xaba8902345659ab0d2a23a7f3dcf5f45038a9a52c2c58d4cfc2c98a384e17e61) |
| 10 | [0x496f6ce7…](https://explorer.testnet.somnia.network/tokyo/tx/0x496f6ce7fa121920153ed50945ff4f91bd1de4273fa710c269be44c9d697912b) | [0x17913e94…](https://shannon-explorer.somnia.network/tx/0x17913e944e04ce945b2281d190210bfb9542fd2fd4316bf457efc393a948aeca) | [0x0015c6ff…](https://shannon-explorer.somnia.network/tx/0x0015c6ff83482e090e42107b5508934ad9a2ad1d45a17846d4ddc9dad53f7797) | [0x1f04852b…](https://shannon-explorer.somnia.network/tx/0x1f04852bb5807e7c4aae67c98ac3d01ff7a7ae0cb93fc40dd39b3617bf59fe55) | [0x955b4563…](https://explorer.testnet.somnia.network/tokyo/tx/0x955b4563f0713f114b4a060b6550ad52712f27b4fab58d0050333c4665f137aa) |
| 11 | [0x52eab7bf…](https://explorer.testnet.somnia.network/tokyo/tx/0x52eab7bfeb1f48bbad20047e9501f1c378e5143e63f49439a4ee6b95daabaaa3) | [0x6ad1ca0a…](https://shannon-explorer.somnia.network/tx/0x6ad1ca0a556238c11a1577169ea116750e7d248b2f0556ca0e4a558de51613bb) | [0x837be4bc…](https://shannon-explorer.somnia.network/tx/0x837be4bc444141dd68d27b3acad8ffb32f9fc9009c852f2350b00dce8ab467ee) | [0xc4977037…](https://shannon-explorer.somnia.network/tx/0xc4977037cd990df5e106d7c3e5242508dfa07761c961078a789310d7cf0c5970) | [0xccfaf1fd…](https://explorer.testnet.somnia.network/tokyo/tx/0xccfaf1fd807bcc45cc17a8af8ae59dd8d75e4abb6fe347446ccdc9bf325f014c) |
| 12 | [0x39c891d4…](https://explorer.testnet.somnia.network/tokyo/tx/0x39c891d4501755dac464e89ee300b05db247b9346a98f13434c7518159f996b4) | [0x369a9f68…](https://shannon-explorer.somnia.network/tx/0x369a9f681a671aa948ddb550c144f4c379500095bbd29dca85097aa290fd3ebe) | [0xe31f8881…](https://shannon-explorer.somnia.network/tx/0xe31f88810558dd19a97893646228c8df95a0db28404ba7938235c501d32f5d6f) | [0xe47db37c…](https://shannon-explorer.somnia.network/tx/0xe47db37c7e3133edf5437bc7c8acef317cd7ce977394e68dc33811f7b6263d58) | [0x8658d693…](https://explorer.testnet.somnia.network/tokyo/tx/0x8658d6938d160f39f9f084b77333f9f07b6423d9a73b92dd5ab32eb3cb3b22b7) |
| 13 | [0xdbc0afbd…](https://explorer.testnet.somnia.network/tokyo/tx/0xdbc0afbd8d5e67f7e6cd5a1019eb0b4be0943ec9c67646d0199f772e6a20c8b1) | [0xd812b6af…](https://shannon-explorer.somnia.network/tx/0xd812b6af861074d51266bd378558e152652c796c71a87ce46fd3a493fe11388f) | [0x806a04cb…](https://shannon-explorer.somnia.network/tx/0x806a04cbaf19e20b47c798155ad21c86b1295f158f34f23447aada7fbe18cd2f) | [0x7acadd39…](https://shannon-explorer.somnia.network/tx/0x7acadd391fce17e013a53f60ec06da47b574c28de605c9dbfd086d1de29ba175) | [0x293135f8…](https://explorer.testnet.somnia.network/tokyo/tx/0x293135f868fb914497583b53ae192aa1a3e49848cc2b2db6a98bae6f08e4a787) |
| 14 | [0x22155772…](https://explorer.testnet.somnia.network/tokyo/tx/0x22155772da5d8ae431338d6fb7b4c3b4cb4a53becdf2f30ee3a48617a079b560) | [0x31db3aab…](https://shannon-explorer.somnia.network/tx/0x31db3aabd31c69459746bacea422d2378498f2085ab378f58114c9c3e83747e3) | [0x17d0fa49…](https://shannon-explorer.somnia.network/tx/0x17d0fa4939a6de3c7d5586ae3b086723d60ffbe484a18d9a05151ad0f8826260) | [0x2cf8de38…](https://shannon-explorer.somnia.network/tx/0x2cf8de38d958e45afaa04e00e4e749b56fe8b9ac71a6715f2d6a7aa6698aae93) | [0x495844c5…](https://explorer.testnet.somnia.network/tokyo/tx/0x495844c5f56640657919d25015d000bf5bc3a27415a7aca1d5d530cd4aa4b1a8) |
| 15 | [0xba096fe8…](https://explorer.testnet.somnia.network/tokyo/tx/0xba096fe8f8559c06b3298a6a05f2a839b907750e32dcfb000dd3e94ce051d5ca) | [0x1584d839…](https://shannon-explorer.somnia.network/tx/0x1584d8397cec0e2307a88ac2a58c657508735d7301f090dedf10415723ea828a) | [0x67791fa0…](https://shannon-explorer.somnia.network/tx/0x67791fa0a2779b6be2771d397d320bdd3a05f7f9b22119cf1d678a097d8fc8cc) | [0xe299fadf…](https://shannon-explorer.somnia.network/tx/0xe299fadfe8f36a83619881093b46f48880f4966179c76af1b0ee27926aabfa15) | [0x296d7f2a…](https://explorer.testnet.somnia.network/tokyo/tx/0x296d7f2aed5c47a2468782124b9d2463b1e4edddb93bc57cfc2678f20788b862) |
| 16 | [0xf6a41f07…](https://explorer.testnet.somnia.network/tokyo/tx/0xf6a41f0740a09a0e74ec6740af4e1b8cfdcc9cb468365ac86f284cce9a671426) | [0x47dab520…](https://shannon-explorer.somnia.network/tx/0x47dab520e5000023465030b92d9dae4d372be09ec56e841abaf28c33234761ab) | [0xfd6ba327…](https://shannon-explorer.somnia.network/tx/0xfd6ba327b8af40b12c695aa0bbdeb935fb146d153880e8c8aa9e2839c9fceeb8) | [0x63865a8f…](https://shannon-explorer.somnia.network/tx/0x63865a8ffadfd197288ef7c4fcf2cf30b6f620c433172d6b4add909cdb9e462a) | [0x3266c83d…](https://explorer.testnet.somnia.network/tokyo/tx/0x3266c83d89fede3385ae2c69f087ef79cfe22b0374ea30ad2e213bd818c93805) |
| 17 | [0x541b0a21…](https://explorer.testnet.somnia.network/tokyo/tx/0x541b0a2160f1e3d27b6214603e8bc06f14fb0368b911a4473ff37ab68c38337e) | [0x29ed3e15…](https://shannon-explorer.somnia.network/tx/0x29ed3e154ea2999550d4e5ee4bb1a875f744184f2a200a2d63522e1d29eebb6d) | [0xec81d433…](https://shannon-explorer.somnia.network/tx/0xec81d433334b53d1a55e7b48da8f1a55495579101d18072f3675d43a50867088) | [0xfda55d21…](https://shannon-explorer.somnia.network/tx/0xfda55d214e7c776686fda574b3eb6d1fa0b0dbc0e6eaacc6cb0f71780dd8ed63) | [0x9f6a3d6d…](https://explorer.testnet.somnia.network/tokyo/tx/0x9f6a3d6dd57b0646fbf9760782d97c5dff65af59f66f12c0c8d388adaa997b49) |
| 18 | [0xea3e41e0…](https://explorer.testnet.somnia.network/tokyo/tx/0xea3e41e0f5e180bc50be6c133ef8a006e1509778d9618e68b6fb668e7e7e34cd) | [0xf5417c47…](https://shannon-explorer.somnia.network/tx/0xf5417c475ba2d4d5f73a91526049748eae94880c604d7a0af433088f247fc05a) | [0xbcc236b8…](https://shannon-explorer.somnia.network/tx/0xbcc236b88a2e014c95db5c14acdf19a330a431d6c9005aa1a262d531d1d150f1) | [0x9ce0ff39…](https://shannon-explorer.somnia.network/tx/0x9ce0ff3984ec03cc6b414f0617ef2692e87a6e6471a469dcb947235a4624d378) | [0x42ed327d…](https://explorer.testnet.somnia.network/tokyo/tx/0x42ed327dbbfb53d63d4003cc3398d73be8c61e1fae728500f1a67975ebe45c84) |
| 19 | [0x824d7e56…](https://explorer.testnet.somnia.network/tokyo/tx/0x824d7e560cd459d6d8a68dbb64490154e8e08db195dae607214dd834aae21f10) | [0xe2a3760d…](https://shannon-explorer.somnia.network/tx/0xe2a3760dea9f992d1348e8b775b63ece1ed9d101de8b1d3cbae64f10f92101a0) | [0xc34aea24…](https://shannon-explorer.somnia.network/tx/0xc34aea241e43c7b8281699874d1447eac2a663dc3f4c54ca508fa2828168ce38) | [0xd7758e90…](https://shannon-explorer.somnia.network/tx/0xd7758e9036127141eedfff62827111d730f59088a3ffd53492f29922e2f6bea9) | [0x135d6518…](https://explorer.testnet.somnia.network/tokyo/tx/0x135d651830f59cd3e2c9ea9274f5938adde68a0e98deb4ed1d8b1c6caa4c04ae) |
| 20 | [0x0180c68c…](https://explorer.testnet.somnia.network/tokyo/tx/0x0180c68cf5d8f9eefc5e400922a62e0312fefc0227eede0e99b78124ae75adde) | [0xdaf552d8…](https://shannon-explorer.somnia.network/tx/0xdaf552d8a8cb4b78e816d51df4b6770d66e438cdce1b72489742166f3663a9c8) | [0xb3609550…](https://shannon-explorer.somnia.network/tx/0xb3609550ac7acef9e2d61bdc3c6aaef19c539e12345ded70fd932012d29ade83) | [0x0208db32…](https://shannon-explorer.somnia.network/tx/0x0208db32108de2958bb42a7273f9cdc74c6a6413fe4dadc2e2f8a12e6ea23495) | [0x8a70ffe5…](https://explorer.testnet.somnia.network/tokyo/tx/0x8a70ffe570747dc782f2557cedfc22826ddda0b94912b624149cb68b6e9c28af) |

#### Run v4 validators

| validator | summary fetches | LLM answers | answers matching the rubric |
|---|---|---|---|
| `0x1Cb38b3ee632B5dCc0347dB81766606d6Aad4926` | 16 | 16 | 16 |
| `0x05f1fE2DDF9B65576D3165E37C6A60e6c5Ba93De` | 14 | 16 | 15 |
| `0x3E05e29029C60E000C8F01EB5AC9cEE6b242D7e0` | 15 | 16 | 15 |
| `0x55Acbe370872c7D90F504eF169217a00c29E2A33` | 15 | 12 | 11 |

### Reading run v4

- **The miss is a missed BLOCK.** Row 6's line is `liquidations30d=10 trades30d=27 history=yes partial=0`, and the
  committee answered CAUTION, 3 votes of 3.
  - **What the gate does with it.** The gate stores that CAUTION, so guarded followers of this trader can still add
    size until a new review says BLOCK. Of the two errors the gate can make, this is the one that leaves a follower
    exposed.
  - **What one review cannot tell.** Lines with 2, 4, 11, 12, 14, 15 and 135 liquidations were all BLOCKed; row 6 is
    the only line with exactly 10. The prompt's other threshold reads "trades30d is below 10", but one review cannot
    show whether the number mattered.
- **Everything else matches the rubric.**
  - every other trader with 2 or more liquidations: 7 of 7;
  - every trader with exactly one: 4 of 4;
  - the clean traders: 6 of 6 OK;
  - the thin trader (4 trades): CAUTION;
  - the high-frequency trader with `partial=1`: CAUTION.
- **How this compares with run v3.** Run v3 scored 18 of 20 on the traders its changes were chosen on, with no missed
  BLOCK. On fresh traders the same setup scored 19 of 20, with one missed BLOCK.
  - The kind of error moved, from thin-history CAUTIONs rated OK to a BLOCK rated CAUTION.
  - The sample also differs: it has 8 BLOCKs and a single thin trader, against 6 and 3.
- **The limits of this run:**
  - one review per trader;
  - 20 traders;
  - no line carried a drawdown percentage, so the 25% and 50% rules are still untested on their own.

### Run v4 cost and latency

- **Reviewer deposits:** 4.3073 STT for 20 reviews, 0.2154 STT each. Over the run, the reviewer went from 9.1103 to
  4.8030 STT.
- **Review fees:** 20 × 0.5 STT, paid to the gate, which the owner can withdraw. The gate held 12 STT after the run.
- **Gas:**
  - `requestReview`: 394,542 – 403,503 (first reviews of these traders write new storage);
  - the anchor: 29,320.
- **Latency,** from the request to the verdict landing on Hideki (block timestamps): median 11.5 s, range 8 – 16 s for
  20 reviews. No delivery was slow.

## Run v3: the rubric as the system message, and only the keys it reads

### What changed from run v2

Two things changed. Everything else is the same as in run v2: the 20 traders in the same order, the rubric and the
words of the prompt, the agents, the committee of 3 with a threshold of 2, and the gate. Both changes were chosen
after reading run v2's errors on this same sample. Run v3 therefore measures them on the traders they were chosen
against, so it is not an out-of-sample estimate; a fresh sample would be.

- **The model sees only the rubric's inputs.** The endpoint now also serves a `rubric` field next to `summary`. It
  holds `liquidations30d`, `trades30d`, `maxDrawdownPct30d` (only when it could be estimated, as in the summary),
  `history` and `partial`, and nothing else. The validators fetch `rubric`, so realized PnL, the absolute drawdown,
  leverage, activity and dates no longer reach the model. For the steady trader of row 1:
  - run v2 saw `trades30d=113 activeDays30d=7 markets=3 realizedPnl30d=+3773.3 liquidations30d=0 maxDrawdown30d=679.3 avgLeverage=n/a lastActive=2026-10-22`;
  - run v3 saw `liquidations30d=0 trades30d=113 history=yes partial=0`.
- **The rubric is the system message.** A new
  [`RiskReviewer`](https://shannon-explorer.somnia.network/address/0xc999B6924179a0dc9649DA7eBa8F3aC8b7CF7c25)
  (verified on the Shannon explorer) calls
  `inferString("Stats: " + line, systemPrompt, false, ["OK", "CAUTION", "BLOCK"])`. Run v2's reviewer put the
  prompt and the stats together in the user prompt and left the system message empty. The new reviewer's
  `DEFAULT_SYSTEM_PROMPT` is the rubric prompt above, so the verified source is what runs, and no `setSystemPrompt`
  was sent. The JSON field is owner-settable (`setSummarySelector`), and its default is `rubric`.

The rubric line gives the same tier as the full summary. `rubric.test.ts` checks this for 448 combinations of the
rule inputs, and it held for all 20 traders here: every expected tier equals run v2's. When the drawdown percentage is
unknown, the line leaves it out rather than writing `n/a`. The rubric's drawdown rules apply only when the percentage
is present, and an `n/a` would fall under "n/a means unknown, not safe": all five OK expectations would become
CAUTION.

Each review records the two agent requests exactly as the reviewer sent them, decoded from the transaction traces
into [`v3/results.json`](v3/results.json):
- All 20 summary requests fetched the field `rubric` from `https://copybook-eosin.vercel.app/api/risk/<trader>`.
- All 20 inference requests carried `Stats: <the agreed line>` as the prompt and the published rubric as the system
  message, with chain of thought off.

### Pre-registration

| step | when (UTC, 2026-10-28) | evidence |
|---|---|---|
| new reviewer deployed | 14:27:18 | [Shannon tx 0x99765a02…](https://shannon-explorer.somnia.network/tx/0x99765a02b814805036c8293ff919d1cb1f0130829d6983272463ed4f919a3ced) (block 526233904) |
| old reviewer's 7.0147 STT back to the owner, new reviewer funded with 10 STT | 14:27:36 – 14:27:37 | [0x8d096cde…](https://shannon-explorer.somnia.network/tx/0x8d096cde6588fa5860035d953606c7d05c82343fe4e15bbb20fad357cd78ebe2), [0x49d4a801…](https://shannon-explorer.somnia.network/tx/0x49d4a8016ba5783c0b156822319f86b3bc21b9877e6690ebfa32c15b6275a84a) |
| gate pointed at the new reviewer (`setReviewer`) | 14:27:41 | [Hideki tx 0xf759ef81…](https://explorer.testnet.somnia.network/tokyo/tx/0xf759ef8170f5fbae91a43c94a96261055bf280afee4375723bf73f7eb782e6b2) |
| rubric lines fetched from the public endpoint | 14:28:36 – 14:29:26 | `fetchedAt` per trader in [`v3/answer-key.json`](v3/answer-key.json) |
| answer key committed | 14:29:33 | commit `5aed53bf2c556d82874cd537cd559f09d51b3d67` |
| commit hash and key hash written on chain | 14:29:44 | [Hideki tx 0xb6792325…](https://explorer.testnet.somnia.network/tokyo/tx/0xb67923259aa552c033eba19271020d41f206c04a44d461ef9237c3752dd40e13) (block 35446065) |
| first review requested | 14:30:05 | row 1 below |
| last verdict delivered to Hideki | 14:42:32 | row 20 below |

The anchor works as in run v2. It is a zero-value self-transfer from the hub owner, and its input is the 20-byte commit
hash followed by the keccak256 of `eval/v3/answer-key.json` as committed
(`0x401403823f836081ab51e8eb1d0306cbe9b71d9c36f717ab244031572620902f`, recorded in [`v3/anchor.json`](v3/anchor.json)).
The anchor step refuses to send unless the committed file is byte-identical to the one it hashes. Nothing on either contract was
changed between the anchor and the last review. This run's reviews have nonces 24 to 43 on the gate.

**Expected tiers:** 5 OK, 9 CAUTION and 6 BLOCK, the same tiers as in run v2.

### Result

**18 of 20 verdicts match the rubric, and the committee's verdicts imply the right gate decision for all 20.**
- **BLOCK recall:** 6 of 6.
- **False BLOCKs:** none, out of 14 traders the rubric does not block.
- **Misses:** two thin-history traders were rated OK where the rubric says CAUTION.
- **Failures:** none. Every committee answered unanimously, and 54 of 60 validator answers match the rubric.
- **Summary hashes:** all 20 lines the committee agreed on are byte-identical to the key. For each one, the JSON stage
  returned the same bytes from all 3 validators.

| expected \ committee | OK | CAUTION | BLOCK | no verdict |
|---|---|---|---|---|
| **OK** | **5** | 0 | 0 | 0 |
| **CAUTION** | 2 | **7** | 0 | 0 |
| **BLOCK** | 0 | 0 | **6** | 0 |

### Per trader

In the table:
- **Rule inputs** come from the line the committee saw.
- **Previous run** is run v2's committee tier for the same trader.
- **Gate:** `BlockHeld` means the gate kept an earlier BLOCK that is less than 24 hours old (see
  [what the gate holds](#what-the-gate-holds-now)). The committee's tier is what is scored.

| # | trader | picked as | rule inputs seen | seen = key | expected | previous run | committee (OK/CAU/BLK) | gate |
|---|---|---|---|---|---|---|---|---|
| 1 | [`0xfc2F…7fd2`](https://explorer.testnet.somnia.network/tokyo/address/0xfc2Fb08CCCF87BFC472cded8E7eBEF588fCF7fd2) | clean | liq 0 · trades 113 | yes | OK | BLOCK | OK (3/0/0) | BlockHeld OK |
| 2 | [`0xA14d…3D14`](https://explorer.testnet.somnia.network/tokyo/address/0xA14d4561F2697859AB6c2d5eb62E1172a6cc3D14) | liquidated-2+ | liq 3 · trades 115 · dd% 92.2 | yes | BLOCK | BLOCK | BLOCK (0/0/3) | VerdictReceived BLOCK |
| 3 | [`0x220c…AF00`](https://explorer.testnet.somnia.network/tokyo/address/0x220c695eFB9a6914a334Ac7b783012F43C0BAF00) | liquidated-2+ | liq 6 · trades 633 | yes | BLOCK | BLOCK | BLOCK (0/0/3) | VerdictReceived BLOCK |
| 4 | [`0x5521…1e69`](https://explorer.testnet.somnia.network/tokyo/address/0x5521160E05bB130783E003F746F03d9D31ea1e69) | liquidated-2+ | liq 3 · trades 337 | yes | BLOCK | BLOCK | BLOCK (0/0/3) | VerdictReceived BLOCK |
| 5 | [`0x1fAe…BFc7`](https://explorer.testnet.somnia.network/tokyo/address/0x1fAeD318FCeD713cC5764BD7B4974b39DDF5BFc7) | liquidated-2+ | liq 3 · trades 38 | yes | BLOCK | BLOCK | BLOCK (0/0/3) | VerdictReceived BLOCK |
| 6 | [`0x7c30…5b96`](https://explorer.testnet.somnia.network/tokyo/address/0x7c30179b81212f592f7D24d37aCbEC408e905b96) | liquidated-2+ | liq 3 · trades 60 | yes | BLOCK | BLOCK | BLOCK (0/0/3) | VerdictReceived BLOCK |
| 7 | [`0x2E6c…42b7`](https://explorer.testnet.somnia.network/tokyo/address/0x2E6c0CD1c011Ec7e7a2d22fB464d7c63d53842b7) | liquidated-2+ | liq 4 · trades 9 | yes | BLOCK | BLOCK | BLOCK (0/0/3) | VerdictReceived BLOCK |
| 8 | [`0xb870…50a8`](https://explorer.testnet.somnia.network/tokyo/address/0xb8700E8d07Bd029f7dD3CE6CC97Fe936D70c50a8) | liquidated-1 | liq 1 · trades 695 | yes | CAUTION | CAUTION | CAUTION (0/3/0) | VerdictReceived CAUTION |
| 9 | [`0xCd50…2D7f`](https://explorer.testnet.somnia.network/tokyo/address/0xCd509d80cDB707dD1871a8aD10b8A399696a2D7f) | liquidated-1 | liq 1 · trades 5 | yes | CAUTION | CAUTION | CAUTION (0/3/0) | VerdictReceived CAUTION |
| 10 | [`0x8B83…e1e4`](https://explorer.testnet.somnia.network/tokyo/address/0x8B834Ce8F8D18D4247F600FBF91C74A8F0ABe1e4) | liquidated-1 | liq 1 · trades 5 | yes | CAUTION | CAUTION | CAUTION (0/3/0) | VerdictReceived CAUTION |
| 11 | [`0xF3ed…08F8`](https://explorer.testnet.somnia.network/tokyo/address/0xF3ed3F5b90A13b39f30759E9800ec638711008F8) | liquidated-1 | liq 1 · trades 555 | yes | CAUTION | CAUTION | CAUTION (0/3/0) | VerdictReceived CAUTION |
| 12 | [`0x8573…d02c`](https://explorer.testnet.somnia.network/tokyo/address/0x857387a56F7ceE3246860a8A470123C31bB0d02c) | clean | liq 0 · trades 2000 · partial=1 | yes | CAUTION | CAUTION | CAUTION (0/3/0) | VerdictReceived CAUTION |
| 13 | [`0x0a72…8Ff4`](https://explorer.testnet.somnia.network/tokyo/address/0x0a72b2e45fB68a8Ff4B0945Ee8104cb5a97D8Ff4) | clean | liq 0 · trades 2000 · partial=1 | yes | CAUTION | BLOCK | CAUTION (0/3/0) | BlockHeld CAUTION |
| 14 | [`0x20A0…bA88`](https://explorer.testnet.somnia.network/tokyo/address/0x20A0d517f1b60fd3041B49d7B97b529964c7bA88) | clean | liq 0 · trades 15 | yes | OK | BLOCK | OK (3/0/0) | BlockHeld OK |
| 15 | [`0xfed4…7749`](https://explorer.testnet.somnia.network/tokyo/address/0xfed46fe76Ac5e98f1C969Bc10eFB96014Dc17749) | clean | liq 0 · trades 16 | yes | OK | OK | OK (3/0/0) | VerdictReceived OK |
| 16 | [`0xE46c…9999`](https://explorer.testnet.somnia.network/tokyo/address/0xE46cd08B8921aFD922051Ee4D11701aEf68d9999) | clean | liq 0 · trades 127 | yes | OK | OK | OK (3/0/0) | VerdictReceived OK |
| 17 | [`0x2c12…2fd8`](https://explorer.testnet.somnia.network/tokyo/address/0x2c12A7432362E335B7A0B2ACCA2F6Ae17a1f2fd8) | thin | liq 0 · trades 3 | yes | CAUTION | OK | **OK** (3/0/0) | VerdictReceived OK |
| 18 | [`0xb9c0…37F3`](https://explorer.testnet.somnia.network/tokyo/address/0xb9c0424B350be6Bb438eE3fdda981212d42037F3) | thin | liq 0 · trades 7 | yes | CAUTION | OK | CAUTION (0/3/0) | VerdictReceived CAUTION |
| 19 | [`0x10ea…2E90`](https://explorer.testnet.somnia.network/tokyo/address/0x10eae18964db8EE7981B51fd93b3B163e8dF2E90) | thin | liq 0 · trades 5 | yes | CAUTION | OK | **OK** (3/0/0) | VerdictReceived OK |
| 20 | [`0xA1d0…7b5d`](https://explorer.testnet.somnia.network/tokyo/address/0xA1d0CB85c869e534Fe1e0c22af3b238301157b5d) | leader | liq 0 · trades 45 | yes | OK | OK | OK (3/0/0) | BlockHeld OK |

<details><summary>Lines the committee saw (from each review's <code>SummaryReceived</code> event)</summary>

| # | rubric line |
|---|---|
| 1 | `liquidations30d=0 trades30d=113 history=yes partial=0` |
| 2 | `liquidations30d=3 trades30d=115 maxDrawdownPct30d=92.2 history=yes partial=0` |
| 3 | `liquidations30d=6 trades30d=633 history=yes partial=0` |
| 4 | `liquidations30d=3 trades30d=337 history=yes partial=0` |
| 5 | `liquidations30d=3 trades30d=38 history=yes partial=0` |
| 6 | `liquidations30d=3 trades30d=60 history=yes partial=0` |
| 7 | `liquidations30d=4 trades30d=9 history=yes partial=0` |
| 8 | `liquidations30d=1 trades30d=695 history=yes partial=0` |
| 9 | `liquidations30d=1 trades30d=5 history=yes partial=0` |
| 10 | `liquidations30d=1 trades30d=5 history=yes partial=0` |
| 11 | `liquidations30d=1 trades30d=555 history=yes partial=0` |
| 12 | `liquidations30d=0 trades30d=2000 history=yes partial=1` |
| 13 | `liquidations30d=0 trades30d=2000 history=yes partial=1` |
| 14 | `liquidations30d=0 trades30d=15 history=yes partial=0` |
| 15 | `liquidations30d=0 trades30d=16 history=yes partial=0` |
| 16 | `liquidations30d=0 trades30d=127 history=yes partial=0` |
| 17 | `liquidations30d=0 trades30d=3 history=yes partial=0` |
| 18 | `liquidations30d=0 trades30d=7 history=yes partial=0` |
| 19 | `liquidations30d=0 trades30d=5 history=yes partial=0` |
| 20 | `liquidations30d=0 trades30d=45 history=yes partial=0` |

</details>

#### Transactions

These are the same five transactions per review as in run v2.

| # | Hideki: requestReview | Shannon: summary request | Shannon: verdict request | Shannon: verdict | Hideki: verdict delivered |
|---|---|---|---|---|---|
| 1 | [0x403b9e76…](https://explorer.testnet.somnia.network/tokyo/tx/0x403b9e76f17de05b704afd4e50dcb9ba8a8ecf9b574b2db0f4102971bde67da7) | [0x9ff258aa…](https://shannon-explorer.somnia.network/tx/0x9ff258aa58a15bdba7de3a6ef6050eb44289280b228460fe8bc109b7cab287d2) | [0x411d8fe0…](https://shannon-explorer.somnia.network/tx/0x411d8fe0cc30449680b5bfd09fc0d5098e593b13bba7fe8d578090ed113e18e4) | [0x9767f41b…](https://shannon-explorer.somnia.network/tx/0x9767f41bdef68987ccb2ce71c2dfb20921a6c697ffb969d16507a62d4e8057a4) | [0xdabd7cc9…](https://explorer.testnet.somnia.network/tokyo/tx/0xdabd7cc9c0bd481d09df85aa8a6067b2c64be30a51d9b6641bac811276843eb7) |
| 2 | [0x80fbb903…](https://explorer.testnet.somnia.network/tokyo/tx/0x80fbb9030770c7f9cbc9dbe9b18f45ffb4fa0f1440d06d8dc17134e7ea33933a) | [0xe92c74f0…](https://shannon-explorer.somnia.network/tx/0xe92c74f04f0d1c512a4bfb37b2acd08d156a365d45c44e65caa0cfc444186a7c) | [0x2fdfb5c0…](https://shannon-explorer.somnia.network/tx/0x2fdfb5c02032f71e0b99b85cc228c4d7bddba0f533f7ebc29c70c973f1ce6e4d) | [0x2f031bd2…](https://shannon-explorer.somnia.network/tx/0x2f031bd20b1b5c9ac7a18d0e52402432ae2f2e78f5772b260125daf96dac539f) | [0x34280d92…](https://explorer.testnet.somnia.network/tokyo/tx/0x34280d921bb1fc19f77ebcf467d74bcb302a9c77e3520e9c14a116bb12e2b862) |
| 3 | [0x1a8c96de…](https://explorer.testnet.somnia.network/tokyo/tx/0x1a8c96debe1752efbec9cc5083593ec99e719f73ad759707c3a6e2aab54e2198) | [0x31d84e8c…](https://shannon-explorer.somnia.network/tx/0x31d84e8cf5f86fb51e8de7f76978d09e6eacbc3a1480fe1d28cae4d4470f36cf) | [0x0df7aee1…](https://shannon-explorer.somnia.network/tx/0x0df7aee1fd71d33ecf73ccb56b01d1b0a136a15944b90a9a29de0e44749cc5b4) | [0x0f299364…](https://shannon-explorer.somnia.network/tx/0x0f29936416e94c96610e5e27ad57cd03b06fce6e76329fd4429da65444f680a0) | [0x9a961ee6…](https://explorer.testnet.somnia.network/tokyo/tx/0x9a961ee66d6406f93c7a689b0c22798698cebc75c2f7e262b99138cb76869363) |
| 4 | [0x356f7547…](https://explorer.testnet.somnia.network/tokyo/tx/0x356f7547b6d37d15639325023d325a21fa7c928d3f1866f232f49024f88897f6) | [0x17c8a1e1…](https://shannon-explorer.somnia.network/tx/0x17c8a1e1616afb8ee8473ab50a2fefc23aee14fa985c1c74b40c2e208b4165f8) | [0xb5b553ab…](https://shannon-explorer.somnia.network/tx/0xb5b553abbd404b502474bc00a5ee324cc70e805d71c4b36c60c7ebf21f1cffad) | [0xb3fec6a7…](https://shannon-explorer.somnia.network/tx/0xb3fec6a74d2c5f25ef5652c9b637b9c710638c26af77f41e466f2ca27eb96d01) | [0xf30edd69…](https://explorer.testnet.somnia.network/tokyo/tx/0xf30edd694ab2a1b9a32519e757224c48c44105427db9f0e8b3ef5b5c3ab091e6) |
| 5 | [0xde50de51…](https://explorer.testnet.somnia.network/tokyo/tx/0xde50de51859989f44dbd9b19f1e719d93b51a5af78159b580e1cc7ee871b1915) | [0x722dbdb1…](https://shannon-explorer.somnia.network/tx/0x722dbdb1722967dab7e58ee468b8bf0fb4b757cd44e679068889a8eeba319faa) | [0xb0e84d7c…](https://shannon-explorer.somnia.network/tx/0xb0e84d7c57db24aeca0180cdd4f6c331870f4d19e65907753dfdbc7db0857bfc) | [0xb8e8eb1d…](https://shannon-explorer.somnia.network/tx/0xb8e8eb1d4e19a4ab3751eb450dab07794a3e7ffdd23a32e14232ff0e22010801) | [0x4d2ce649…](https://explorer.testnet.somnia.network/tokyo/tx/0x4d2ce64987961989d8da8bb492e9b3b5484dd7f78a141086f838e7588cc0da66) |
| 6 | [0x95ee27fd…](https://explorer.testnet.somnia.network/tokyo/tx/0x95ee27fd495556683b8655eaf098638529cc69dff942aff056e589a361a946cd) | [0x54b36df7…](https://shannon-explorer.somnia.network/tx/0x54b36df76b9b77a11b8607f02c359726d3e830968a829b8de8f035380c321694) | [0xf9d7ebfb…](https://shannon-explorer.somnia.network/tx/0xf9d7ebfb1b9d05a05a9eabc2e7c1f0c6535ac5d74925b43f2578f01199beaa4d) | [0x6dcf3e32…](https://shannon-explorer.somnia.network/tx/0x6dcf3e3265be533da4b2d6be28f06b98db4198b8e30b0c792120bb9844a0a93f) | [0xddaaae04…](https://explorer.testnet.somnia.network/tokyo/tx/0xddaaae0431ece232945a0bc1835093fd73898381d19532e3f2a45157bbd42fbe) |
| 7 | [0xe8a53858…](https://explorer.testnet.somnia.network/tokyo/tx/0xe8a53858cb1c9d675905affa067def447945e322192de3022d021ce44cdf5774) | [0x125d0413…](https://shannon-explorer.somnia.network/tx/0x125d0413b50cf6c45892f3d872598827359ccac299ff596d549be27624c98be7) | [0x23d64404…](https://shannon-explorer.somnia.network/tx/0x23d644045994440cf3ae232a4e8756800ab3e4b17fb56687387b6b881e0d276a) | [0x74019ca3…](https://shannon-explorer.somnia.network/tx/0x74019ca3d5f1a6627552d50da2ae67f7a387b267abb8e05697122dabef66d591) | [0x6da631e0…](https://explorer.testnet.somnia.network/tokyo/tx/0x6da631e04cba6c8a14b0b75a1438a3313f67bd8cd23fedcdc1263aa91d855343) |
| 8 | [0x5411d84c…](https://explorer.testnet.somnia.network/tokyo/tx/0x5411d84cc31929d90676a7c4f47e09786bf0eed2e8805a26b21f3981be9f5f49) | [0x5f820951…](https://shannon-explorer.somnia.network/tx/0x5f820951fe56d1750c61733ff8f34c36adcf86536e827c68b8e3d6032041d04c) | [0xd03ab0c6…](https://shannon-explorer.somnia.network/tx/0xd03ab0c6c6035a2bdf51348a85b4a74dea8b254f736ad526dd30169e693524cd) | [0xb932983a…](https://shannon-explorer.somnia.network/tx/0xb932983a5e66d21db8deee561906d46ea13857f29e6b1cfc79e7d407e4bad501) | [0xbbd029a6…](https://explorer.testnet.somnia.network/tokyo/tx/0xbbd029a6446258771e621abda077f444ebdfae40611384f16a426d4ba2578013) |
| 9 | [0x75c00cd5…](https://explorer.testnet.somnia.network/tokyo/tx/0x75c00cd5ce913779c6b399adca078544a5ccf80bd01723cc6facffd545e85043) | [0xa74ae7c5…](https://shannon-explorer.somnia.network/tx/0xa74ae7c56cc2da81c9d5e159450395ce3897270be98e10fcffb46e537d20dbd1) | [0xeeb459a0…](https://shannon-explorer.somnia.network/tx/0xeeb459a07c74f41da7ce2c19e71373c01c701f25a4346f9f0ea35a863e45917e) | [0x2fef81e0…](https://shannon-explorer.somnia.network/tx/0x2fef81e0a6b3494d628cd5763385acccc37c893736369234937a43513e4e68e6) | [0x08e46745…](https://explorer.testnet.somnia.network/tokyo/tx/0x08e46745c5266b61729c4cf9f7dcdd978b929d0e7e7bab1b00084b7b926cbb40) |
| 10 | [0x5670de9e…](https://explorer.testnet.somnia.network/tokyo/tx/0x5670de9e5e41f439f2e2d2e18541d78e52dfc223efd4d7112c15b0f862b26e0e) | [0x430c1c08…](https://shannon-explorer.somnia.network/tx/0x430c1c08bafc02cacd6df5e15898bcd04213e05b5593863689d7a371da09f629) | [0x50b71b11…](https://shannon-explorer.somnia.network/tx/0x50b71b11465d72139e647194584f9323288638176a3777a4e1a5530885bce8d5) | [0xf5320de3…](https://shannon-explorer.somnia.network/tx/0xf5320de330699041233f43ed97f0b0de51391afa39079e3df9da7bf44735fc27) | [0xb14f9843…](https://explorer.testnet.somnia.network/tokyo/tx/0xb14f98439d4e4f28b55e59762ed3446b002b79f63e9b110050e8350569eda5ad) |
| 11 | [0x1876872e…](https://explorer.testnet.somnia.network/tokyo/tx/0x1876872e72131140aebab78920a5ff979521ade33b184648cfc3417cc55935eb) | [0x1bbab7c0…](https://shannon-explorer.somnia.network/tx/0x1bbab7c05b97aadcffd7f5f3bf6bb16906ae6869b20a62f49e2a9ea653735bda) | [0x976da656…](https://shannon-explorer.somnia.network/tx/0x976da6565da9980173c30a33c85f8ce50cf5c5a2123e429216444021bb93e56f) | [0x2ff2d1bb…](https://shannon-explorer.somnia.network/tx/0x2ff2d1bb4c2c0ad5f0025e741154123151f4a185e24b042ac475fc104b5a25b4) | [0xc73cb9f4…](https://explorer.testnet.somnia.network/tokyo/tx/0xc73cb9f44bf2dd43c7f033a8c3d347c319c41c2b8318972dca5ad27ae693d5aa) |
| 12 | [0xe7bcb9a5…](https://explorer.testnet.somnia.network/tokyo/tx/0xe7bcb9a5810fc0e2244f98905d61a5b42a5b7131f38cdd4ece97a52edc8bf399) | [0xef3c6b3f…](https://shannon-explorer.somnia.network/tx/0xef3c6b3f05fee7221fd2e94541ca9a263ceba117260095d596562a07d2398f6b) | [0xfecd29a5…](https://shannon-explorer.somnia.network/tx/0xfecd29a5f811b5514d407619ecfcb9cf3503d925731ace74c4178cba754271fd) | [0x55c95c4e…](https://shannon-explorer.somnia.network/tx/0x55c95c4e8a71c47cf4e3911288706b4b38bbf555658a46188553ff188d098057) | [0x3da88689…](https://explorer.testnet.somnia.network/tokyo/tx/0x3da886898a1a98bfbce9d779cf06a907a5a6b639431a5486bdda719f8afde0c4) |
| 13 | [0x47fd55c3…](https://explorer.testnet.somnia.network/tokyo/tx/0x47fd55c36df01d8ecc1f7614b57ab3c27ea6ccffced80d495cbacafcd499e8a7) | [0x2a33b4de…](https://shannon-explorer.somnia.network/tx/0x2a33b4deca24b460844a7ff7739903bdf60af32c3061b18bde33969f9102c245) | [0xe8442ff9…](https://shannon-explorer.somnia.network/tx/0xe8442ff9fb7b8f3675883e71354d6e7d76d1ae4bf3975672064f4da5e6f2f398) | [0xb9a011e1…](https://shannon-explorer.somnia.network/tx/0xb9a011e16fafdf0419ea313cd250fc3ef75fa070f1ca282e2040480733d7f1e4) | [0x240a69f1…](https://explorer.testnet.somnia.network/tokyo/tx/0x240a69f17db716d43337b9c0fcfd312bb2dfbf730a8be21a4c6feaf3dab8bf04) |
| 14 | [0x07f6a965…](https://explorer.testnet.somnia.network/tokyo/tx/0x07f6a9652498b0bad31ff8cc13c1a45cb73043523b22de54c3ab3a472fae43f8) | [0xcefb2331…](https://shannon-explorer.somnia.network/tx/0xcefb23310ffa68065724b490c05c191ee6a9f5f1dfd1210a45444c0b1820b6a9) | [0x4fc4b555…](https://shannon-explorer.somnia.network/tx/0x4fc4b555266e5e7b54772f96c161470453a373b21f4ccc2610a2cf28bf5e0bf6) | [0x235a016c…](https://shannon-explorer.somnia.network/tx/0x235a016c3a78c39f7d2a14f7bde82abcf7a823df76f364c22894ec2b0464f70e) | [0x0508c85c…](https://explorer.testnet.somnia.network/tokyo/tx/0x0508c85cdac2d00809f77192477c016c7162447a8a6c8a1fae067695cff6a6ec) |
| 15 | [0xbd0dcda2…](https://explorer.testnet.somnia.network/tokyo/tx/0xbd0dcda26706f95cf55113503b384aa6a9472d65f80a5adfb9cb1d5481a875d9) | [0xe7c885c3…](https://shannon-explorer.somnia.network/tx/0xe7c885c3798aea0e0bfd49b12429b76898e076612c38fa76778805fb15150216) | [0xb9f078a4…](https://shannon-explorer.somnia.network/tx/0xb9f078a4f2630aa07f463507efef6d8ae51ab3a0e3d759324bee669ce2e49223) | [0x2f315323…](https://shannon-explorer.somnia.network/tx/0x2f315323f2c401c8519d3d41c108447f195535a7d414e02826ee17284cab2fd5) | [0x3365ce1d…](https://explorer.testnet.somnia.network/tokyo/tx/0x3365ce1d6cd3e0cd48794bd77f940c0938b0098c58e36f4ed1b4471c7595ba1f) |
| 16 | [0x26b6ed81…](https://explorer.testnet.somnia.network/tokyo/tx/0x26b6ed8172d49c0b0ce578e4309fc1d233e03eeea843802755110fb0df9c1998) | [0x3cf94872…](https://shannon-explorer.somnia.network/tx/0x3cf94872ab42a64b43b7ef9913a5e240786280b76d95cb64c1461ced14649c20) | [0x054d13e5…](https://shannon-explorer.somnia.network/tx/0x054d13e5b4d98d7381e7486d421566c08e9b62a51fce8815fc1b215c2dee9179) | [0x28b6aedb…](https://shannon-explorer.somnia.network/tx/0x28b6aedb3b4780ccb230ed06c4d31a9f4259f77205bac50c899b159bd6475c6d) | [0x434322c2…](https://explorer.testnet.somnia.network/tokyo/tx/0x434322c237105ed540c3e84a2b447a838f18ed1af3894885bbe9f3bf46a05f9d) |
| 17 | [0xd6b70821…](https://explorer.testnet.somnia.network/tokyo/tx/0xd6b70821f95fe71845a37f587b8067764d2366751808715540791928fb45a9f7) | [0xa8119658…](https://shannon-explorer.somnia.network/tx/0xa81196585f56f47f290e6c2ce57c84192c3ebf8282b49fe4f21e8c5d2d0f8187) | [0xf14ac07e…](https://shannon-explorer.somnia.network/tx/0xf14ac07e803e856b90abc02f728dffea33797322c8b2b2be9ca933e931912d25) | [0x0fde9c04…](https://shannon-explorer.somnia.network/tx/0x0fde9c04d6bcb217b6843c0bf0746ede3212e7860dc923b22a72f48f726ef558) | [0x1910739a…](https://explorer.testnet.somnia.network/tokyo/tx/0x1910739aaf06535c870c0978c13f2063014b43e22ede7b69628daf64b848b16a) |
| 18 | [0x7746a737…](https://explorer.testnet.somnia.network/tokyo/tx/0x7746a7378cc5d3b2a093c7c884cb0d82c802e444dd8e4202afe3f5c3aa872cc9) | [0x4cc0da46…](https://shannon-explorer.somnia.network/tx/0x4cc0da46b3068594235d5ca8c04be1bc240182b21381e9ef1f04d03750ccc318) | [0x241939ff…](https://shannon-explorer.somnia.network/tx/0x241939ff615533fd4c46d948210b272513bf7561ba4adc98956fe4f26c35dd75) | [0x8a260f5c…](https://shannon-explorer.somnia.network/tx/0x8a260f5c6be9f0182c51462b40401abbcf161a3dde69f40b87068bf47820c7de) | [0x7e446e90…](https://explorer.testnet.somnia.network/tokyo/tx/0x7e446e907b8907bb04ef2c1fd166d1984e7a2126c837d2a81634fcbd07bbe804) |
| 19 | [0x56a19d94…](https://explorer.testnet.somnia.network/tokyo/tx/0x56a19d94918ea5527cbf4962eb6a56a2a0f64de40c3b5cda24f60d187357a414) | [0x34f0f09d…](https://shannon-explorer.somnia.network/tx/0x34f0f09d93c5edf215daa4dcfee8206d94df7c30ec71b962e8a780a4fc1989b8) | [0x6dcc6129…](https://shannon-explorer.somnia.network/tx/0x6dcc6129ee10184e8689d12a111e6ab7602d26323099babffc69bad722f4b660) | [0xbadee804…](https://shannon-explorer.somnia.network/tx/0xbadee804b8193e2d735039aa289f4412d3dd84bddc52ddd00c7eadb0c3e225ba) | [0xe4000df4…](https://explorer.testnet.somnia.network/tokyo/tx/0xe4000df4d7440e8fb2ccde67cfb013a70a3779061211ea4f8af31c9b107b4e8f) |
| 20 | [0xae7bd792…](https://explorer.testnet.somnia.network/tokyo/tx/0xae7bd79212d9d2541c372ef348e0ac63e61998f35b36e3ae19eaa963cf2d79cb) | [0xd0fb5831…](https://shannon-explorer.somnia.network/tx/0xd0fb5831837fdd82efa69872ba0e672ff988625eaa62b4f626cc9dc68515b797) | [0x63478464…](https://shannon-explorer.somnia.network/tx/0x63478464150fbe3d921c68606f174dee00a5eb56c50c86876d3ff82f96c7edb2) | [0x39933fa4…](https://shannon-explorer.somnia.network/tx/0x39933fa48b30060e2f19a3d502a282914bbca7f3fd5a21041fb5095415e767ff) | [0x1525f30c…](https://explorer.testnet.somnia.network/tokyo/tx/0x1525f30c37a7dc72a33897ef0071bd149ef326f6ae0b0832ae7279d87e5906c3) |

#### Validators

Four validators served these requests, three per request. The three answers to each request were identical, as in
run v2.

| validator | summary fetches | LLM answers | answers matching the rubric |
|---|---|---|---|
| `0x3E05e29029C60E000C8F01EB5AC9cEE6b242D7e0` | 14 | 18 | 16 |
| `0x05f1fE2DDF9B65576D3165E37C6A60e6c5Ba93De` | 18 | 17 | 16 |
| `0x55Acbe370872c7D90F504eF169217a00c29E2A33` | 13 | 14 | 12 |
| `0x1Cb38b3ee632B5dCc0347dB81766606d6Aad4926` | 15 | 11 | 10 |

### Reading the result

- **False BLOCKs: 3 → 0.** Run v2 wrongly blocked rows 1, 13 and 14. In this run they got OK, CAUTION and OK, which
  matches the rubric:
  - row 1 is the profitable steady trader;
  - row 13 is a high-frequency account with `partial=1`;
  - row 14 has 15 trades and lost 464.9.

  Their lines no longer carry PnL or an absolute drawdown.
- **Liquidations: 10 of 10,** as in run v2.
- **`partial=1`: 2 of 2** (run v2: 1 of 2).
- **Clean traders expected OK: 5 of 5** (run v2: 3 of 5).
- **Thin history: 1 of 3** (run v2: 0 of 3). `trades30d < 10` is the only rule that fires for rows 17 to 19:
  - row 18 (7 trades) now gets CAUTION;
  - rows 17 and 19 (3 and 5 trades) still get OK.

  The thin-data rule is still not applied reliably.
- **BLOCK / not-BLOCK agreement: 20 of 20** (run v2: 17 of 20). The gate acts on BLOCK only, so the two remaining
  misses do not change the gate decision the verdicts imply. The live gate still refuses new size for 4 of these 20
  traders (rows 1, 13, 14 and the leader): their earlier false BLOCKs were less than 24 hours old when run v3's
  milder verdicts arrived, so the gate kept them (see [what the gate holds](#what-the-gate-holds-now)).
- **What this run cannot separate.** The inputs and the prompt placement changed together, so this run does not show
  which change removed the false BLOCKs. Each trader was again reviewed once. The answers were unanimous within every
  committee, but run-to-run stability was not tested.
- **Review 30 (row 7) took 320 seconds.** The Hyperlane relayer delivered its request to Shannon about 5 minutes after
  it was sent, a few blocks before the next review's request, which had gone out in the meantime. The review script's
  300-second wait ran out first. The review completed on its own: BLOCK, 3 votes of 3, and `VerdictReceived` on the
  gate in [Hideki tx 0x6da631e0…](https://explorer.testnet.somnia.network/tokyo/tx/0x6da631e04cba6c8a14b0b75a1438a3313f67bd8cd23fedcdc1263aa91d855343).
  `npm run risk follow 30` read it back from the chain afterwards. The committee's work does not depend on the
  script watching it.

### Cost and latency

- **Reviewer deposits:** 4.3073 STT for 20 reviews, 0.2154 STT each. Over the run, the new reviewer went from 10 to
  5.6927 STT.
- **Review fees:** 20 × 0.5 STT, paid to the gate, which the owner can withdraw. The gate held 21.5 STT at 15:07:08 UTC
  on 2026-10-28, after run v3.
- **Gas:**
  - new reviewer: 47,234,479 (0.2834 STT at 6 gwei);
  - `withdraw` from the old reviewer: 58,705;
  - funding: 21,067;
  - `setReviewer`: 41,403;
  - the anchor: 29,320;
  - `requestReview`: 194,592 – 203,553.
- **Latency,** from the request to the verdict landing on Hideki (block timestamps): median 11 s, range 7 – 18 s for 19
  reviews. One delivery, review 30, took about 320 s.

## Run v2: the rubric in the user prompt, with the full summary

The reviewer at
[`0x45b4…ECc3`](https://shannon-explorer.somnia.network/address/0x45b46d39697Cfd191BfEb215512d012d28E6ECc3) ran this
run. Its balance was returned to the owner when the gate moved to run v3's reviewer.

**Result: 14 of 20 verdicts match the rubric.**
- Every trader the rubric blocks was blocked: 6 of 6, with no misses.
- Three traders were blocked that the rubric would not block.
- Three thin-history traders were rated OK where the rubric says CAUTION.
- The gate acts only on BLOCK, so for "can a guarded follower add size" the committee was right 17 times in 20. All 3
  errors are false blocks.
- No review failed, and every committee answered unanimously.

### The prompt

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

### Pre-registration

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

### The sample

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

### Confusion matrix

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

### Per trader

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

#### Transactions

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

#### Validators

Four validators served these requests, three per request. In the summary stage, all three returned identical bytes on
every review. In the verdict stage, the three answers were also identical on every review.

| validator | summary fetches | LLM answers | answers matching the rubric |
|---|---|---|---|
| `0x05f1fE2DDF9B65576D3165E37C6A60e6c5Ba93De` | 19 | 18 | 12 |
| `0x3E05e29029C60E000C8F01EB5AC9cEE6b242D7e0` | 15 | 16 | 11 |
| `0x1Cb38b3ee632B5dCc0347dB81766606d6Aad4926` | 15 | 14 | 9 |
| `0x55Acbe370872c7D90F504eF169217a00c29E2A33` | 11 | 12 | 10 |

### Reading the misses

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
- **Unanimous within every committee.** All three validators gave the same word on every request. A committee of
  three therefore confirmed one model output here; it did not give three independent opinions. Run-to-run stability
  was not tested: each trader was reviewed once in this run. The steady trader of row 1 got BLOCK from the same summary
  bytes under both the first prompt and this one.

The gate acts on BLOCK only (`allowIncrease` refuses a guarded follower's increase for a BLOCK younger than 7 days).
Confusing OK with CAUTION therefore changes nothing a follower can do, but a false BLOCK stops a follower from adding
to a trader the policy would allow.

### Cost and latency

- **Reviewer deposits:** 4.3387 STT for 20 reviews, 0.2169 STT each. The reviewer went from 11.3534 to 7.0147 STT.
  The committees used 0.0003 STT per validator to fetch the summary and 0.07 STT per validator to classify it. The
  platform returns the unused part of each deposit.
- **Review fees:** 20 × 0.5 STT, paid to the gate, which the owner can withdraw. The gate held 11.5 STT after run v2.
- **Gas:**
  - `requestReview` on Hideki: 194,592 – 407,983;
  - `setSystemPrompt`: 208,877;
  - the anchor: 29,320.
- **Latency,** from the request to the verdict landing on Hideki (block timestamps): median 14.5 s, range 9 – 26 s for
  20 reviews.

## Run v1: the first prompt

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

Run v3 rates all three as the rubric does: steady OK, liquidated BLOCK, leader OK.

## What the gate holds now

As read from the gate at block 36,612,170 (22:53:52 UTC on 2026-10-29), after run v4:

- **BLOCK, 13 traders, all of them BLOCKs under the rubric:**
  - run v3's rows 2–7, which expire between 14:30 and 14:38 UTC on 2026-11-04;
  - run v4's rows 1–5, 19 and 20, which expire between 22:44 and 22:51 UTC on 2026-11-05.

  A BLOCK stops blocking after 7 days unless a new BLOCK refreshes it, and a milder verdict can replace it 24 hours
  after it landed.
- **Run v4's row 6** holds CAUTION, the missed BLOCK above. Guarded followers of that trader are not protected.
- **Run v3's earlier false BLOCKs are gone.** Rows 1, 13, 14 and the leader held BLOCKs from runs v1 and v2 that run
  v3's milder verdicts could not replace inside the 24-hour hold. Fresh reviews between 17:08 and 17:09 UTC on
  2026-10-29 (gate nonces 44–47) replaced them with OK, CAUTION, OK and OK.
- **CAUTION and OK.** The other traders hold CAUTION or OK, and neither restricts anyone. Run v3's rows 17 and 19 hold
  OK where the rubric says CAUTION.

## Limitations

- **The Hyperlane lane is a dev lane.** Both directions run through the testnet lane, and each side's ISM has a single
  validator (the same key on both). Whoever holds that key could deliver a forged verdict, a BLOCK included. The
  committee's work is verifiable on Shannon, but the Hideki gate trusts the lane.
- **The platform's per-response `receipt` field is 0** in every response of every run. What the validators actually
  signed is the callback transactions above and the responses they carry, decoded in each run's `results.json`.
- **LLM output depends on the prompt.** In each run, each trader was reviewed once. The three validators always agreed,
  but run-to-run stability was not tested. The answer depends on the exact prompt and line bytes, and a trader whose
  line changes can get a different answer. Twenty reviews per run is a small sample, and run v3 changed two things at once.
- **The committee can miss a BLOCK.** In run v4 a trader with 10 liquidations got CAUTION, 3 votes of 3. The gate then
  lets guarded followers add size to that trader until a new review says BLOCK.
- **Some rules were barely tested.** `maxDrawdownPct30d` appears for only one trader in all four runs (92.2%, already
  BLOCK for its liquidations), so the 25% and 50% drawdown thresholds were not tested on their own. No screened trader
  had `history=none`. Run v4's sample has a single thin trader, because the thin pool came up short.
- **Run v3 is not an out-of-sample estimate; run v4 is.** Run v3's changes were chosen after reading run v2's errors
  on the same sample, so its 18 of 20 is not an out-of-sample estimate.
  - Run v4 used 20 traders no earlier run had reviewed or screened, with every part of run v3's setup unchanged. It
    scored 19 of 20, with one missed BLOCK.
  - Run v4 is still a single review per trader on 20 traders, and its strata differ from runs v2 and v3.
- **The thin-data rule is not reliable.** Run v3 applied it to 1 of 3 thin traders, and run v4 to its single thin
  trader. The gate does not act on CAUTION,
  but the published policy is not fully applied.
- **The rubric is public.** It is a published policy that the validators apply, not a secret model. A trader can read
  the thresholds; the value is in applying the policy where anyone can check it. Each verdict carries the hash of the
  summary it judged, and the rubric is mechanical, so anyone can recompute the expected tier. This scorecard was built
  that way.
- **The data comes from our endpoint.** The JSON committee attests that its members fetched identical bytes from it,
  not that those bytes are true. The summary and the rubric line are computed from the dreamDEX indexer with a
  2,000-row cap (`partial=1` beyond it).

## Reproduce

```sh
cd e2e
npm ci                                                 # e2e's dependencies, with packages/stats linked
npm run eval:test                                      # the rubric's unit tests, incl. rubric line = summary tier
npm run typecheck

# run v2
COPYBOOK_ENV=keys.env npm run eval select              # sample + eval/answer-key.json (commit it)
COPYBOOK_ENV=keys.env npm run risk prompt              # reviewer.setSystemPrompt(rubric)
COPYBOOK_ENV=keys.env npm run risk review <trader>     # one paid review, followed on both chains
npm run eval score                                     # eval/results.json

# run v3: deploy a reviewer with GATE=<gate> (see e2e/README.md), then
COPYBOOK_ENV=keys.env npm run risk swap-reviewer 10    # old balance back, new one funded, gate.setReviewer
npm run eval key v3                                    # eval/v3/answer-key.json (commit it)
COPYBOOK_ENV=keys.env npm run eval anchor v3 <commit>  # commit + key hash on Hideki
COPYBOOK_ENV=keys.env npm run risk review <trader>     # each trader in the key, in order
COPYBOOK_ENV=keys.env npm run risk follow <nonce>      # only if a delivery outlasted the script's wait
npm run eval score v3                                  # eval/v3/results.json and the run v3 tables

# run v4 (held out): the same reviewer and settings, nothing changed
COPYBOOK_ENV=keys.env npm run eval:v4 select           # fresh sample + eval/v4/answer-key.json (commit it)
COPYBOOK_ENV=keys.env npm run eval:v4 anchor <commit>  # commit + key hash on Hideki
COPYBOOK_ENV=keys.env npm run risk review <trader>     # each trader in the key, in order
npm run eval:v4 score                                  # eval.ts unchanged, on run v4's key -> eval/v4/results.json
npm run eval:v4 score --reproduce-v3                   # the same wrapper on run v3's key reproduces eval/v3/results.json
```

To check a pre-registration, hash the committed key with keccak256 and compare the result with the last 32 bytes of
the anchor transaction's input:
- run v2: `git show 6b1b074:eval/answer-key.json`, anchor
  [0x1f70dc46…](https://explorer.testnet.somnia.network/tokyo/tx/0x1f70dc46bfee488d482591cffb54200795ed332b903678dfa77c85359a4dcd31)
  (recorded in [`anchor.json`](anchor.json));
- run v3: `git show 5aed53b:eval/v3/answer-key.json`, anchor
  [0xb6792325…](https://explorer.testnet.somnia.network/tokyo/tx/0xb67923259aa552c033eba19271020d41f206c04a44d461ef9237c3752dd40e13)
  (recorded in [`v3/anchor.json`](v3/anchor.json));
- run v4: `git show a7c42c2:eval/v4/answer-key.json`, anchor
  [0xadd80abe…](https://explorer.testnet.somnia.network/tokyo/tx/0xadd80abe7fdd825fe6f4086d62b09c44f50d2aeb2519b0479462e0a14be06b09)
  (recorded in [`v4/anchor.json`](v4/anchor.json)).
