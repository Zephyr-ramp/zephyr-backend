# Security Policy

Zephyr moves money. We take reports seriously and will work with you to fix and disclose them responsibly.

> **Status:** testnet only and **not audited**. Do not use it with real funds.

## Reporting a vulnerability

**Never open a public issue, discussion or pull request for a vulnerability.**

Report privately through either channel:

1. **GitHub Security Advisories (preferred):** [open a private advisory](https://github.com/zephyr-ramp/zephyr-backend/security/advisories/new).
2. **Email:** the security contact listed on the [zephyr-ramp organization profile](https://github.com/zephyr-ramp).

Please include the affected endpoint or module, the commit, what an attacker could do (for example get paid twice, bypass SEP-10, forge a webhook, or read someone else's transaction), and a reproduction, ideally a failing test.

## What to expect

| Step                                           | Target          |
| ---------------------------------------------- | --------------- |
| Acknowledge your report                        | 3 business days |
| Initial assessment and severity                | 7 days          |
| Fix, or a mitigation plan, for critical issues | 30 days         |

We'll credit you in the advisory unless you ask us not to, and agree a disclosure date with you.

## Scope

In scope: SEP-10 authentication, SEP-24 authorization (reading or changing other users' transactions), interactive and more_info tokens, the transaction state machine (double payouts, paying without funds received), rail webhook verification, escrow claim/cancel logic, wallet callbacks (SSRF), and HTML injection in interactive pages.

Out of scope: the `/sandbox` endpoints (disabled outside testnet by design), findings that require a compromised server or operator keys, and denial of service by volume.
