#!/usr/bin/env node
// Node.js 18+; no packages or private keys required. Read-only RPC calls.
// Usage: node fetch-agw-signers.mjs [--input snapshot.json] [--output result.csv]
// Options: --rpc URL --block NUMBER --batch-size 200 --concurrency 3 --limit N
// Optional: --checkpoint-dir DIRECTORY (otherwise checkpoints sit beside CSV).
// Re-running the same output resumes its checkpoint at the original block.
// To take a NEW snapshot, choose a different --output filename.
// First signer means k1ListOwners()[0], NOT necessarily the original/primary key.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY = '0xd5e3efda6bb5ab545cc2358796e96d9033496dda';
const MULTICALL = '0xca11bde05977b3631167028862be2a173976ca11';
const SELECTORS = { isAGW: '932bdb47', owners: '85867cdf', aggregate3: '82ad56cb' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const word = value => BigInt(value).toString(16).padStart(64, '0');
const addressWord = value => value.slice(2).padStart(64, '0');
const csvCell = value => /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;

function options() {
  const allowed = new Set(['input', 'output', 'rpc', 'block', 'batch-size', 'concurrency', 'limit', 'checkpoint-dir']);
  const args = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const name = process.argv[i].replace(/^--/, '');
    if (!allowed.has(name) || !process.argv[i + 1]) throw new Error(`Invalid option ${process.argv[i]}`);
    args[name] = process.argv[i + 1];
  }
  const positive = (name, fallback) => {
    const n = Number(args[name] ?? fallback);
    if (!Number.isSafeInteger(n) || n < 1) throw new Error(`Invalid ${name}`);
    return n;
  };
  return {
    input: path.resolve(args.input ?? path.join(HERE, 'abstract-chickens-tier-snapshot.json')),
    output: path.resolve(args.output ?? path.join(HERE, 'agw-tier-signers.csv')),
    rpc: args.rpc ?? 'https://api.mainnet.abs.xyz',
    checkpointDir: args['checkpoint-dir'] ? path.resolve(args['checkpoint-dir']) : null,
    block: args.block == null ? null : `0x${BigInt(args.block).toString(16)}`,
    batchSize: positive('batch-size', 200),
    concurrency: positive('concurrency', 3),
    limit: args.limit == null ? null : positive('limit', 1)
  };
}

export function encodeAggregate(calls) {
  const tuples = calls.map(({ to, data }) => {
    const bytes = data.slice(2);
    return addressWord(to) + word(1) + word(96) + word(bytes.length / 2) + bytes.padEnd(Math.ceil(bytes.length / 64) * 64, '0');
  });
  let offset = calls.length * 32;
  const offsets = tuples.map(tuple => { const out = word(offset); offset += tuple.length / 2; return out; });
  return `0x${SELECTORS.aggregate3}${word(32)}${word(calls.length)}${offsets.join('')}${tuples.join('')}`;
}

function abiReader(hex) {
  if (!/^0x(?:[0-9a-f]{2})*$/i.test(hex)) throw new Error('Malformed ABI bytes');
  const bytes = Buffer.from(hex.slice(2), 'hex');
  const integer = offset => {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + 32 > bytes.length) throw new Error('ABI offset outside response');
    const n = BigInt(`0x${bytes.subarray(offset, offset + 32).toString('hex')}`);
    if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('ABI integer too large');
    return Number(n);
  };
  return { bytes, integer };
}

export function decodeAggregate(hex, expected) {
  const { bytes, integer } = abiReader(hex);
  const start = integer(0);
  const count = integer(start);
  if (count !== expected) throw new Error(`Expected ${expected} call results, got ${count}`);
  const heads = start + 32;
  return Array.from({ length: count }, (_, i) => {
    const tuple = heads + integer(heads + i * 32);
    const success = integer(tuple);
    if (success !== 0 && success !== 1) throw new Error('Malformed success flag');
    const dataStart = tuple + integer(tuple + 32);
    const length = integer(dataStart);
    if (dataStart + 32 + length > bytes.length) throw new Error('Truncated call result');
    return { success: success === 1, data: `0x${bytes.subarray(dataStart + 32, dataStart + 32 + length).toString('hex')}` };
  });
}

export function firstOwner(hex) {
  const { bytes, integer } = abiReader(hex);
  const start = integer(0);
  const count = integer(start);
  if (start + 32 + count * 32 > bytes.length) throw new Error('Truncated owner array');
  if (!count) return { signer: '', ownerCount: 0 };
  const value = bytes.subarray(start + 32, start + 64);
  if (value.subarray(0, 12).some(byte => byte !== 0)) throw new Error('Malformed owner address');
  const signer = `0x${value.subarray(12).toString('hex')}`;
  if (/^0x0{40}$/.test(signer)) throw new Error('Zero owner address');
  // Only the first owner is retained. No other owner addresses are saved.
  return { signer, ownerCount: count };
}

async function main() {
  const cfg = options();
  const inputBytes = fs.readFileSync(cfg.input);
  const source = JSON.parse(inputBytes.toString('utf8').replace(/^\uFEFF/, ''));
  const wallets = (cfg.limit ? source.wallets.slice(0, cfg.limit) : source.wallets).map(w => {
    if (!/^0x[0-9a-f]{40}$/i.test(w.address) || !Array.isArray(w.tiers) || w.tiers.length > 1) throw new Error('Unexpected input wallet/tier');
    return { address: w.address.toLowerCase(), tier: w.tiers[0] ?? '' };
  });
  if (new Set(wallets.map(w => w.address)).size !== wallets.length) throw new Error('Duplicate input addresses');
  const selectionHash = sha256(JSON.stringify(wallets));
  const stem = cfg.output.replace(/\.csv$/i, '');
  if (cfg.checkpointDir) fs.mkdirSync(cfg.checkpointDir, { recursive: true });
  const checkpointStem = cfg.checkpointDir ? path.join(cfg.checkpointDir, path.basename(stem)) : stem;
  const statePath = `${checkpointStem}.state.json`;
  const checkpointPath = `${checkpointStem}.checkpoint.jsonl`;
  const metadataPath = `${stem}.metadata.json`;
  fs.mkdirSync(path.dirname(cfg.output), { recursive: true });
  let requestId = 0;
  let rpcRequests = 0;
  let rpcRetries = 0;

  async function rpc(method, params) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        rpcRequests++;
        const response = await fetch(cfg.rpc, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }),
          signal: AbortSignal.timeout(45000)
        });
        if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
        const body = await response.json();
        if (body.error) throw new Error(`RPC ${body.error.code}: ${body.error.message}`);
        if (!Object.hasOwn(body, 'result')) throw new Error('RPC result missing');
        return body.result;
      } catch (error) {
        if (attempt === 4) throw error;
        rpcRetries++;
        await sleep(Math.min(16000, 1000 * 2 ** attempt));
      }
    }
  }

  const chainId = Number(BigInt(await rpc('eth_chainId', [])));
  if (chainId !== 2741) throw new Error(`Wrong chain: ${chainId}`);
  let state;
  if (fs.existsSync(statePath)) {
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (state.selectionHash !== selectionHash || state.inputSha256 !== sha256(inputBytes)) throw new Error('Input differs from checkpoint; select a new output filename');
    if (cfg.block && cfg.block !== state.blockTag) throw new Error('Requested block differs from checkpoint');
  } else {
    const block = await rpc('eth_getBlockByNumber', [cfg.block ?? 'latest', false]);
    if (!block) throw new Error('Snapshot block unavailable');
    state = { chainId, blockTag: block.number, blockNumber: Number(BigInt(block.number)), blockHash: block.hash,
      blockTimestamp: new Date(Number(BigInt(block.timestamp)) * 1000).toISOString(),
      startedAt: new Date().toISOString(), inputSha256: sha256(inputBytes), selectionHash, inputCount: wallets.length };
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  }
  async function checkBlockHash() {
    const block = await rpc('eth_getBlockByNumber', [state.blockTag, false]);
    if (!block || block.hash !== state.blockHash) throw new Error('Snapshot block hash changed/unavailable; do not mix snapshots');
  }
  await checkBlockHash();
  const code = await rpc('eth_getCode', [MULTICALL, state.blockTag]);
  if (code === '0x') throw new Error('Multicall3 is not deployed at the requested block');

  const results = new Map();
  const inputAddresses = new Set(wallets.map(w => w.address));
  if (fs.existsSync(checkpointPath)) {
    // Ignore and trim an incomplete final line after an interrupted append.
    const content = fs.readFileSync(checkpointPath, 'utf8');
    const end = content.lastIndexOf('\n') + 1;
    for (const line of content.slice(0, end).split('\n').filter(Boolean)) {
      const row = JSON.parse(line);
      if (!inputAddresses.has(row.address)) throw new Error('Unexpected checkpoint address');
      results.set(row.address, row);
    }
    if (end !== content.length) fs.truncateSync(checkpointPath, Buffer.byteLength(content.slice(0, end)));
  }
  const pending = wallets.filter(w => !results.has(w.address));
  let cursor = 0;
  let batchCount = 0;
  console.log(`Block ${state.blockNumber} (${state.blockHash}); ${wallets.length} addresses; ${results.size} already saved`);

  async function processBatch(batch) {
    const calls = batch.flatMap(w => [
      { to: REGISTRY, data: `0x${SELECTORS.isAGW}${addressWord(w.address)}` },
      { to: w.address, data: `0x${SELECTORS.owners}` }
    ]);
    const raw = await rpc('eth_call', [{ to: MULTICALL, data: encodeAggregate(calls) }, state.blockTag]);
    const decoded = decodeAggregate(raw, calls.length);
    return batch.map((w, i) => {
      const registered = decoded[i * 2];
      const owners = decoded[i * 2 + 1];
      const row = { address: w.address, tier: w.tier, signer: '', status: '', ownerCount: 0 };
      if (!registered.success || !/^0x[0-9a-f]{64}$/i.test(registered.data)) throw new Error(`Registry read failed for ${w.address}`);
      const registryValue = BigInt(registered.data);
      if (registryValue !== 0n && registryValue !== 1n) throw new Error('Invalid registry boolean');
      if (registryValue === 0n) { row.status = 'not_registered_agw'; return row; }
      if (!owners.success || owners.data === '0x') { row.status = 'owner_call_failed'; return row; }
      const owner = firstOwner(owners.data);
      return { ...row, ...owner, status: owner.signer ? 'ok' : 'no_k1_owner' };
    });
  }

  async function worker() {
    while (cursor < pending.length) {
      const start = cursor;
      cursor += cfg.batchSize;
      const batch = pending.slice(start, start + cfg.batchSize);
      const rows = await processBatch(batch);
      // One synchronous append per completed batch makes resume deterministic.
      fs.appendFileSync(checkpointPath, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
      for (const row of rows) results.set(row.address, row);
      batchCount++;
      if (batchCount % 10 === 0 || results.size === wallets.length) {
        const missing = [...results.values()].filter(row => row.status !== 'ok').length;
        console.log(`${results.size}/${wallets.length} saved; ${missing} without a signer; ${rpcRetries} RPC retries`);
      }
    }
  }
  const outcomes = await Promise.allSettled(Array.from({ length: cfg.concurrency }, worker));
  const failure = outcomes.find(outcome => outcome.status === 'rejected');
  if (failure) throw failure.reason;
  await checkBlockHash();
  if (results.size !== wallets.length) throw new Error('Incomplete snapshot; resume to finish');

  // Retry any registered AGW with a failed multicall directly before export.
  for (const w of wallets) {
    const row = results.get(w.address);
    if (row.status !== 'owner_call_failed') continue;
    try {
      const raw = await rpc('eth_call', [{ to: w.address, data: `0x${SELECTORS.owners}` }, state.blockTag]);
      const owner = firstOwner(raw);
      const updated = { ...row, ...owner, status: owner.signer ? 'ok' : 'no_k1_owner' };
      results.set(w.address, updated);
      fs.appendFileSync(checkpointPath, JSON.stringify(updated) + '\n');
    } catch (error) { console.error(`Unresolved owner for ${w.address}: ${error.message}`); }
  }
  await checkBlockHash();

  const rows = wallets.map(w => results.get(w.address));
  const csv = ['agwAddress,Tier,SignerAddress', ...rows.map(row => [row.address, row.tier, row.signer].map(csvCell).join(','))].join('\r\n') + '\r\n';
  fs.writeFileSync(`${cfg.output}.tmp`, csv, 'utf8');
  fs.renameSync(`${cfg.output}.tmp`, cfg.output);
  const statuses = {};
  for (const row of rows) statuses[row.status] = (statuses[row.status] ?? 0) + 1;
  const metadata = {
    ...state, completedAt: new Date().toISOString(), rpc: cfg.rpc, registry: REGISTRY, multicall: MULTICALL,
    csvSha256: sha256(csv), rows: rows.length, statuses,
    rowsWithTier: rows.filter(row => row.tier).length,
    rowsWithoutTier: rows.filter(row => !row.tier).length,
    walletsWithMultipleK1Owners: rows.filter(row => row.ownerCount > 1).length,
    distinctSavedSigners: new Set(rows.filter(row => row.signer).map(row => row.signer)).size,
    selection: 'First address returned by k1ListOwners() at the recorded block. Other owner addresses are not retained.',
    sourceManifestVersion: source.metadata?.manifest?.version ?? null,
    blankTierMeaning: 'The mint allowlist has no tier for this address (friends-and-family-only eligibility).',
    blankSignerMeaning: 'No confirmed AGW K1 signer was found; consult exceptions. Never assumed equal to the input address.',
    exceptions: rows.filter(row => row.status !== 'ok').map(({ address, tier, status }) => ({ agwAddress: address, Tier: tier, reason: status })),
    rpcRequestsThisRun: rpcRequests, rpcRetriesThisRun: rpcRetries
  };
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
  console.log(JSON.stringify({ output: cfg.output, metadata: metadataPath, rows: rows.length, statuses,
    multiOwnerWallets: metadata.walletsWithMultipleK1Owners, distinctSigners: metadata.distinctSavedSigners,
    block: state.blockNumber, rpcRequests, rpcRetries }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.stack ?? error); process.exitCode = 1; });
}
