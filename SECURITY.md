# Security policy

WingLog is a desktop application for a flight simulator. It has no server, no user
accounts, and stores its data in a local SQLite database — so the realistic risk surface
is narrower than most software. That said, it does parse third-party data (SimBrief OFPs,
GSX receipts, imported CSVs), open external URLs, and ship as an installable binary, and
reports about any of those are welcome.

## Reporting a vulnerability

**Please don't open a public issue for a security problem.**

Use GitHub's private vulnerability reporting instead — the **Report a vulnerability**
button under the repository's **Security** tab. That opens a private channel visible only
to the maintainer.

Please include what you'd expect: what the issue is, how to reproduce it, and what an
attacker could achieve. A proof of concept helps but isn't required.

This is a solo, spare-time project, so response times are best-effort rather than
contractual. Expect an acknowledgement within a couple of weeks. There is no bug bounty.

## Scope

In scope:

- Anything that lets untrusted input — a crafted OFP, a crafted GSX receipt file, a
  malicious CSV, a hostile SimConnect payload — execute code, escape the renderer, read
  files outside the app's own data, or write outside it.
- Credential handling: the SimBrief username and any future API tokens stored in
  `app_setting`.
- Unsafe handling of external URLs, including anything reachable through
  `shell.openExternal`.
- Supply chain issues in the dependencies actually shipped (see
  [`THIRD-PARTY-LICENSES.md`](./THIRD-PARTY-LICENSES.md) for the list).

Out of scope:

- Findings that require an attacker to already have local access to the user's machine and
  their unencrypted user profile. The database is a plain local file by design; it isn't
  an encrypted vault and doesn't claim to be.
- Missing hardening flags with no demonstrated impact. `sandbox: false` is set on the
  window deliberately, for the preload — a report needs to show what it actually enables.
- Vulnerabilities in Microsoft Flight Simulator, SimConnect, SimBrief, GSX, or any other
  third-party product. Report those to their authors.
- Anything about the licence, or about the app's data-collection practices. It doesn't
  collect any.

## Supported versions

The latest release, and `main`. There are no long-term support branches.
