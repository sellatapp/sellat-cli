#!/usr/bin/env node
/**
 * Pay Sellat per call with x402 (USDC on Base): no account, no API key.
 *
 *   node x402-stamp.mjs proof <file> [--name <name>] [--max-usd <n>] [--dry-run]
 *   node x402-stamp.mjs proof --hash <sha256> [--name <name>] [--max-usd <n>] [--dry-run]
 *   node x402-stamp.mjs seal <proof-id> [--max-usd <n>] [--dry-run]
 *
 * What this script touches, and nothing else:
 *   - reads the file given, locally, to hash it; only its SHA-256 is sent;
 *   - environment: SELLAT_WALLET_KEY (only on a real payment, never printed)
 *     and SELLAT_API_URL (optional; only Sellat's own hosts are accepted);
 *   - network: HTTPS to that Sellat host only, redirects refused.
 *
 * Before paying it reads the live price list (GET /api/v2/x402) and pays only
 * an offer that is on Base, in the listed USDC, to the listed Sellat address,
 * and at or below --max-usd. --dry-run asks for the offer without any wallet,
 * key or signature and prints it. Paying accepts Sellat's terms, whose URL and
 * version are in the offer.
 *
 * Dependencies (only for a real payment): the official x402 client and viem,
 * pinned in package-lock.json. Install them once with
 *   npm ci --prefix <this folder> --ignore-scripts
 * This script never installs anything itself.
 */
import { createHash, webcrypto } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { basename } from 'node:path';

const BASE_NETWORK = 'eip155:8453';
const DEFAULT_MAX = { proof: 0.05, seal: 1.0 };
const ALLOWED_HOSTS = new Set(['sellat.app', 'staging.sellat.app']);

function fail(message) {
  console.error(`x402-stamp: ${message}`);
  process.exit(1);
}

/** Sellat's production host, its staging host, or a local dev server; nothing else. */
function apiBase() {
  const raw = process.env.SELLAT_API_URL ?? 'https://sellat.app';
  let url;
  try { url = new URL(raw); } catch { fail(`SELLAT_API_URL is not a URL: ${raw}`); }
  const local = url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  const sellat = url.protocol === 'https:' && ALLOWED_HOSTS.has(url.hostname);
  if (!local && !sellat) fail(`SELLAT_API_URL must be https://sellat.app, https://staging.sellat.app or a localhost server, not ${url.origin}.`);
  return url.origin;
}

const API = apiBase();

/** Every request: no redirects, so a request (or a payment signature) never leaves the Sellat host. */
function sellatFetch(input, init = {}) {
  return fetch(input, { ...init, redirect: 'error' });
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { positional: [] };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--name') options.name = rest[++i];
    else if (arg === '--hash') options.hash = rest[++i];
    else if (arg === '--max-usd') options.maxUsd = Number(rest[++i]);
    else options.positional.push(arg);
  }
  return { command, options };
}

async function sha256File(path) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    createReadStream(path).on('data', (chunk) => hash.update(chunk)).on('end', resolve).on('error', reject);
  });
  return hash.digest('hex');
}

/** The published price list: price for this resource, Sellat's address and the USDC asset on Base. */
async function priceList(listedUrl) {
  const res = await sellatFetch(`${API}/api/v2/x402`);
  if (!res.ok) fail(`could not read the price list (${res.status}).`);
  const list = await res.json();
  if (!list.open) fail('pay-per-call is closed on this Sellat environment.');
  const resource = list.resources?.find((r) => r.method === 'POST' && r.url === listedUrl);
  if (!resource) fail(`no price listed for ${listedUrl}.`);
  const base = list.networks?.find((n) => n.id === BASE_NETWORK);
  if (!base || !list.pay_to) fail('the price list names no Base network or no payee.');
  return { usd: Number(resource.price_usd), payTo: list.pay_to, asset: base.asset, terms: list.terms_acceptance };
}

/** The offer must be exactly what the price list publishes. */
function offerMatches(requirement, list) {
  return requirement.network === BASE_NETWORK
    && String(requirement.payTo).toLowerCase() === String(list.payTo).toLowerCase()
    && String(requirement.asset).toLowerCase() === String(list.asset).toLowerCase();
}

/** --dry-run: one unsigned request, whose 402 answer carries the offer as JSON. No wallet involved. */
async function showOffer(url, body, list, max) {
  const res = await sellatFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status !== 402) fail(`expected a payment offer (HTTP 402), got HTTP ${res.status}.`);
  const answer = await res.json().catch(() => ({}));
  const accepted = (answer.accepts ?? []).find((r) => offerMatches(r, list));
  if (!accepted) fail('no offer on Base to the address in the price list. Nothing would be paid.');
  console.log(JSON.stringify({
    dry_run: true,
    would_pay_usd: list.usd,
    max_usd: max,
    network: accepted.network,
    pay_to: accepted.payTo,
    amount_atomic: accepted.amount,
    terms: list.terms,
    request: { url, body: body ?? null },
  }, null, 2));
}

async function pay(url, body, list, max) {
  const key = process.env.SELLAT_WALLET_KEY;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key ?? '')) fail('SELLAT_WALLET_KEY is missing or malformed (0x + 64 hex). Nothing paid.');

  // Node 18 has Web Crypto but does not expose it globally; the x402 client needs it.
  if (!globalThis.crypto) globalThis.crypto = webcrypto;

  let x402;
  try {
    x402 = {
      fetch: await import('@x402/fetch'),
      evm: await import('@x402/evm/exact/client'),
      accounts: await import('viem/accounts'),
    };
  } catch {
    fail('dependencies missing. Install the pinned versions once: npm ci --prefix <this scripts folder> --ignore-scripts');
  }

  const client = new x402.fetch.x402Client();
  client.setSpendControls({ maxAmountPerPayment: `$${max}` });
  // Pay only what the published price list says: Base, its USDC, Sellat's address.
  client.registerPolicy((_version, requirements) => requirements.filter((r) => offerMatches(r, list)));
  client.register(BASE_NETWORK, new x402.evm.ExactEvmScheme(x402.accounts.privateKeyToAccount(key)));
  const paidFetch = x402.fetch.wrapFetchWithPayment(sellatFetch, client);

  const res = await paidFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let answer;
  try { answer = JSON.parse(text); } catch { answer = { raw: text }; }
  if (!res.ok) {
    console.error(JSON.stringify({ status: res.status, ...answer }, null, 2));
    process.exit(1);
  }
  if (answer.api_key) {
    console.error('Keep the api_key below: it is shown once and reads this wallet\'s proofs for free.');
  }
  console.log(JSON.stringify(answer, null, 2));
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  let url;
  let listedUrl;
  let body;
  if (command === 'proof') {
    const file = options.positional[0];
    const hash = options.hash ?? (file ? await sha256File(file) : null);
    if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) fail('give a file or --hash <64 hex characters>.');
    url = listedUrl = `${API}/api/v2/proofs`;
    body = { hash: hash.toLowerCase(), ...(options.name || file ? { name: options.name ?? basename(file) } : {}) };
  } else if (command === 'seal') {
    const id = options.positional[0];
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) fail('give the proof id (a UUID).');
    url = `${API}/api/v2/proofs/${id}/qualified`;
    listedUrl = `${API}/api/v2/proofs/{id}/qualified`;
  } else {
    fail('usage: x402-stamp.mjs proof <file>|--hash <sha256> [--name n] | seal <proof-id>   [--max-usd n] [--dry-run]');
  }

  const list = await priceList(listedUrl);
  const max = Number.isFinite(options.maxUsd) ? options.maxUsd : DEFAULT_MAX[command];
  if (list.usd > max) fail(`the live price is ${list.usd} USD, above --max-usd ${max}. Nothing paid.`);

  if (options.dryRun) await showOffer(url, body, list, max);
  else await pay(url, body, list, max);
}

main().catch((error) => fail(error?.message ?? String(error)));
