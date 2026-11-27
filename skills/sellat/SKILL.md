---
name: sellat
description: Create independently verifiable proof that an exact file or record existed at a given time and has not changed since (proof of existence, timestamping, tamper-evident audit trail). Hashes locally with SHA-256 and sends only the hash; anchors it on Polygon and Bitcoin, with an optional eIDAS qualified timestamp. Use when the user wants to timestamp, notarize, seal or protect a file, contract, photo, dataset, release or log; when an agent must leave evidence of its own outputs, decisions or execution logs; when a job in several steps should end as one verifiable file with a single link a person can open; or when checking a file against an existing Sellat proof. Works with a Sellat API key or, without an account, paying per call over x402 (USDC on Base).
license: MIT
compatibility: Requires Node.js 18.11+ and network access to sellat.app. The pay-per-call route also needs npm packages @x402/fetch, @x402/evm and viem, and a wallet with USDC on Base set up by the user.
metadata:
  author: sellat
  homepage: https://sellat.app/developers
  version: "1.1.0"
---

# Sellat: proof that exact data existed at a time

Sellat turns the SHA-256 of a file or record into a proof that anyone can
verify without trusting Sellat: the hash goes into a Merkle batch anchored on
Polygon within minutes and attested on Bitcoin (OpenTimestamps) hours later.
An optional qualified eIDAS timestamp (RFC 3161) can be added to a proof.

## What a proof shows, and what it does not

Say this accurately to the user; never overstate it.

- It shows that **these exact bytes existed no later than the anchored time**
  and **have not changed since**: one different byte and verification fails.
- It does **not** show who wrote the file, that an action described in a log
  really happened, that a record is complete, or that its content is true.
- It is not a notary act and does not by itself make anyone "compliant".
  With the qualified timestamp, EU law presumes the accuracy of the date and
  the integrity of the data (eIDAS art. 41.2); say no more than that.

## Ground rules

1. **The file stays local.** Only the 64-hex SHA-256 travels. Never upload the
   file unless the user explicitly asks for custody (`--store`).
2. **The qualified timestamp costs money.** Add it only when the user asks for
   it, or when the date must hold up before a third party and the user agrees.
3. **Never create, fund or move a wallet yourself.** The pay-per-call route
   uses a wallet the user set up for this purpose, with a spend cap.
4. Same bytes twice return the existing proof; it is not charged again.
5. **A link is public.** `sellat link` publishes a group's name and the name
   of each of its proofs to anyone who has the URL. Run it only when the user
   asked for a link or agreed to share, and never put in a `--name` or a
   `--group` anything the user would not show.

## Route A: with a Sellat account (API key)

The user creates a key at https://sellat.app/keys and exports it as
`SELLAT_API_TOKEN`. Free accounts get a daily allowance of proofs; qualified
timestamps are bought on the account.

```bash
npx -y sellat-cli stamp ./contract.pdf --wait          # proof; prints the proof.json URL when anchored
npx -y sellat-cli stamp --hash <sha256> --name run-42  # hash computed elsewhere
npx -y sellat-cli status <id>                          # state, anchors, seal, URLs
npx -y sellat-cli seal <id>                            # qualified eIDAS timestamp (paid)
npx -y sellat-cli download <id> evidence --out ./      # ZIP: certificate, proof.json, .ots, how to verify
npx -y sellat-cli account                              # today's allowance, timestamps left
npx -y sellat-cli stamp ./step.pdf --group "Order 1234" --name "2. Invoice sent"   # one step of a job
npx -y sellat-cli link "Order 1234"                    # one public link for the whole job
```

Add `--json` to any command for machine-readable output.

## Route B: no account, pay per call (x402)

For an agent with its own wallet: each call is paid in USDC on Base with the
x402 protocol. No sign-up, no API key. Current prices, networks and the terms
that a payment accepts are always at `GET https://sellat.app/api/v2/x402`;
read them there, do not assume them.

```bash
npm install --prefix scripts                 # once: @x402/fetch, @x402/evm, viem
export SELLAT_WALLET_KEY=0x…                  # set by the user, never printed or logged
node scripts/x402-stamp.mjs proof ./agent-run.jsonl --dry-run   # shows the offer, pays nothing
node scripts/x402-stamp.mjs proof ./agent-run.jsonl             # pays one proof
node scripts/x402-stamp.mjs seal <proof-id>                      # pays one qualified timestamp
```

The script hashes locally, reads the live price, refuses to pay above
`--max-usd` (defaults: 0.05 for a proof, 1.00 for a timestamp), and prints
the API's answer. The **first proof of a wallet returns a read-only API key
once**: keep it, then use Route A's read commands with it
(`SELLAT_API_TOKEN=<that key> npx -y sellat-cli status <id>`). A failed call
is not charged: the payment settles only after the work is done.

## A whole job: one group, one link

One proof shows one moment. When a job has several steps and a person will
have to review it afterwards (an order, a report with its sources, a task you
were delegated), file every step under one **group** and hand over one link.
This needs Route A (an API key): a wallet that pays per call has no groups.

1. **Choose the group's name once**, at the start, and reuse it exactly:
   something the user would recognise, such as `Order 1234` or
   `Report Q3 – ACME`. The group is created by its first proof; there is
   nothing to set up and no id to keep.
2. **Stamp each step when it happens**, with the same `--group` and a
   `--name` that says what the step is, numbered so the order reads at a
   glance:

   ```bash
   npx -y sellat-cli stamp ./brief.md      --group "Report Q3 – ACME" --name "1. Brief received"
   npx -y sellat-cli stamp ./sources.json  --group "Report Q3 – ACME" --name "2. Sources gathered"
   npx -y sellat-cli stamp ./report.pdf    --group "Report Q3 – ACME" --name "3. Report delivered"
   ```

   Stamp the file that is the evidence of the step: what you received, what
   you produced, the receipt a third party gave you. Do not stamp a sentence
   saying that you did something; it proves only that the sentence existed.
3. **Close the job with the link**, once the user wants it shared (rule 5):

   ```bash
   npx -y sellat-cli link "Report Q3 – ACME"            # prints the URL
   npx -y sellat-cli link "Report Q3 – ACME" --off      # pauses it; nothing is deleted
   ```

   Whoever opens the URL, without an account, sees the steps in
   chronological order, each one checked at that moment, and can download
   the certificate and the evidence package of each. Give the user the URL
   and tell them it is public for anyone who has it.

Be accurate about what the file shows:

- Each record existed, exactly as it is, no later than its proven date, and
  has not changed. It does **not** show that the step really happened, that
  nothing was left out, or that the content is true. Say "the file shows the
  invoice existed on that date", never "the file proves I sent the invoice".
- **Order.** The link orders steps by the date of their anchor. A free
  account anchors every four hours, so steps stamped within the same slot
  share one proven date and their order is not proven. When the order
  matters, write the SHA-256 of the previous step's file inside the next
  step's file before stamping it: then the later one cannot have existed
  first.
- A proof is in one group. Stamping the same bytes again with another
  `--group` moves it there.

`npx -y sellat-cli groups` lists the account's groups and their links;
`npx -y sellat-cli list --group "Report Q3 – ACME"` lists one group's proofs.

## Sealing an agent's own records

For a long run with many small events (tool calls, decisions), a group of
hundreds of proofs helps nobody. Seal the hash of the record, not each event:

1. Write the run's log as you normally would (JSONL is fine), each entry
   carrying the SHA-256 of the previous one.
2. At the end of the task, or every N minutes, seal the hash of the last entry.
3. Keep the log and the proof together. Anyone can later recompute the chain
   and check the proof; altering, removing or reordering an earlier entry
   breaks it.

The log stays on your side; Sellat only sees the hash. The two fit together:
file that sealed log as one step of the job's group.

## Verifying a proof

Verification needs neither Sellat nor an account. See
[references/VERIFY.md](references/VERIFY.md) for the commands (browser,
`sellat-verify`, OpenSSL for the qualified timestamp, OpenTimestamps for
Bitcoin).

## Links

- Developers: https://sellat.app/developers
- API reference: https://sellat.app/en/developers/docs
- OpenAPI: https://sellat.app/developers/openapi.json
- Pay per call (x402) price list: https://sellat.app/api/v2/x402
- Verifier: https://github.com/skanthemore/sellat-verify
