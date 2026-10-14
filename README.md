# Abstract AGW signer snapshot

A community snapshot preserving the association between Abstract Global Wallet addresses, Abstract Chickens mint eligibility tiers, and the first K1 owner address returned by each AGW.

**[Download the CSV](https://raw.githubusercontent.com/Morgosh/abstract-agw-signer-snapshot/main/agw-tier-signers.csv)**

```csv
agwAddress,Tier,SignerAddress
```

Captured on **14 October 2026**, using Abstract mainnet block **87,586,568** for every owner and registry lookup.

| Result | Count |
|---|---:|
| Input wallet addresses | 59,122 |
| Addresses with a tier in the source allowlist | 58,655 |
| Tiered addresses with a resolved signer | 58,654 |
| Total addresses with a resolved signer | 58,713 |
| Friends-and-family-only addresses with no recorded tier | 467 |
| Addresses not registered as AGWs at the snapshot block | 408 |
| Registered AGW with an unreadable owner list | 1 |
| AGWs with multiple K1 owners, retaining only the first | 6 |

All input addresses remain in the CSV. A blank `Tier` means the source only supplied friends-and-family eligibility. A blank `SignerAddress` means no confirmed K1 signer was obtained; it is never replaced with the input address or an inferred owner. All exceptions are listed in `agw-tier-signers.metadata.json`.

The one unresolved tiered wallet is `0x33a49af30730fc0416a2a381f95ea7a37e4a54ad` (Gold I). It was registered as an AGW, but `k1ListOwners()` returned empty bytes in both the batched and direct calls at the snapshot block.

## What the signer field means

`SignerAddress` is **`k1ListOwners()[0]` at the recorded block**, after checking the official AGW registry. Other owner addresses are not retained. The first returned address is not necessarily the original signer, a specially designated primary signer, or the only owner. Owners can change after this snapshot.

This is public address data. It contains no private keys, login information, or user identity records. A saved association can help a future project recognize a signature from the recorded signer; any such project must decide its own eligibility and ownership-verification rules. This dataset does not establish current control, recreate an AGW on another chain, or promise any airdrop.

## Sources and coverage

The wallet list and tier labels come from the publicly served [Abstract Chickens allowlist manifest](https://abstractchickens.lol/allowlist/manifest.json) and its 256 JSON shards. The source version is:

```text
2fee1ea816cdd396e8023e5e0a1d03f66e3c2abe01d441504aa26ffbdfda8ef2
```

The allowlist contains Ethereal, Obsidian, Diamond, Platinum, Gold III, Gold II, and Gold I. It is a **partial list of Abstract users**, not a complete chain snapshot. Higher tier groups do not expose their sublevels. The manifest does not state the time of the underlying Portal tier snapshot, so tier labels must not be treated as current Portal attestations. The dataset contains no XP totals, badges, trading volume, or bridge history.

All 59,276 eligibility proofs were verified against the website's published Merkle roots when the source was downloaded. This verifies consistency with those roots, not the correctness of the original Portal assignments. `abstract-chickens-tier-snapshot.json` preserves the extracted addresses, source manifest, shard URLs, and hashes.

Owner lookup uses the official AGW SDK's registry address and the public `k1ListOwners()` method:

- [AGW SDK deployment constants](https://github.com/Abstract-Foundation/abstract-packages/blob/main/packages/agw-client/src/constants.ts)
- [AGW owner manager source](https://github.com/Abstract-Foundation/agw-contracts/blob/main/contracts/managers/OwnerManager.sol)
- Registry: `0xd5E3efDA6bB5aB545cc2358796E96D9033496Dda`
- Chain ID: `2741`
- Block: `87586568`
- Block timestamp: `2026-10-14T08:40:30Z`
- Block hash: `0xc6cd8034c80d92651c0ae9a53b2255c7bb9885fa400cb636257028a6dabd79c1`

This is an RPC-derived community record, not an official Abstract attestation or a cryptographic storage-proof archive.

## Reproduce the owner lookup

Requires Node.js 18 or newer. No packages, wallet connection, signing, gas, or private keys are needed.

```sh
node fetch-agw-signers.mjs --block 87586568 --output reproduced.csv
```

For a new snapshot of the same input list:

```sh
node fetch-agw-signers.mjs --output new-snapshot.csv
```

Optional arguments: `--input FILE`, `--rpc URL`, `--batch-size 200`, `--concurrency 3`, `--checkpoint-dir DIRECTORY`, and `--limit N`.

The script batches read-only registry and owner calls through Multicall3, pins all reads to one block, retries RPC failures, and saves a resumable checkpoint. Repeating a run with its original checkpoint resumes at the original block. Choose a different output filename for a new snapshot.

Reproduction requires an RPC that still serves state at the requested block. The published CSV remains readable without Abstract infrastructure.

## Validation

- All 59,122 output rows were reconciled against the source addresses and tiers, with no duplicate addresses.
- Signer addresses from the batching implementation were compared with 20 independent direct owner-list calls.
- An additional 42 direct `k1IsOwner(signer)` checks passed, covering every tier group and all six wallets with multiple K1 owners.
- ABI decoding checks covered empty owner lists, multiple owners, truncated responses, and zero addresses.
- The block hash was checked before and after collection.

CSV SHA-256:

```text
bd8b28cc6232363c4fc8058dee1b01918d34a8a3a8a33f88d8a59bc1f9133a4e
```

Community preservation effort; not affiliated with or endorsed by Abstract, Abstract Chickens, or any potential reward issuer.
