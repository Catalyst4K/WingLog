# Contributing

WingLog is a personal project, developed solo. Issues and discussion are welcome;
unsolicited pull requests may not be merged, and that's not a judgement on the code.

If you do want to contribute, please read the licensing section first — it matters more
here than in most small projects, and it isn't negotiable after the fact.

## Licensing of contributions

WingLog is distributed under the **GNU General Public License v3.0**
([`LICENSE`](./LICENSE)). Copyright in the first-party code is held by Callum Jones, who
**retains the option to offer this software under other terms as well**, including a
commercial licence.

That option only survives while a single party holds, or is licensed broadly enough to
grant, rights in the whole work. A single merged contribution licensed to the project
under GPL-3.0 alone would permanently remove it — the contributor's code could then only
ever be distributed under the GPL, and no commercial licence covering the whole work
could be granted without their agreement.

So, **inbound contributions are accepted under the MIT licence**, while the project as a
whole continues to be distributed under GPL-3.0. By submitting a contribution you confirm
that:

1. You wrote it, or otherwise have the right to submit it.
2. You license it to the project under the [MIT licence](https://opensource.org/license/mit).
3. You understand it will be distributed as part of a GPL-3.0 work, and may also be
   distributed under other terms, including commercially.

MIT is one-way compatible with GPL-3.0, so this arrangement keeps the public project
fully GPL while leaving relicensing possible. It's the same shape a great many
dual-licensed projects use, minus the paperwork of a signed CLA.

Please state in your pull request that you agree to the above.

If you'd rather not license your work that way, that's entirely reasonable — open an
issue describing the change instead, and it can be implemented independently.

## Third-party code and data

Anything added to `dependencies` or `resources/` has to be compatible with **both** the
GPL-3.0 distribution and a potential commercial one. Practically, that rules out:

- **Copyleft code libraries** (GPL, AGPL). LGPL is workable but carries real obligations —
  see the node-simconnect section of [`THIRD-PARTY-LICENSES.md`](./THIRD-PARTY-LICENSES.md)
  for what meeting them actually involves.
- **Unlicensed data.** Scraped or undocumented third-party datasets are the easiest way to
  create a problem that only surfaces once money is involved.
- **Share-alike data licences**, unless the consequence is understood and documented. The
  vendored airline database is ODbL and therefore share-alike; it's kept because the
  obligation falls on the dataset rather than the code, and it's disclosed.

When adding a production dependency:

```
npm run licenses:generate    # regenerates THIRD-PARTY-LICENSES.md — commit the result
```

The script warns if a dependency's licence normally requires its text to be reproduced but
ships no licence file. Don't ignore that warning.

## Working agreement

[`CLAUDE.md`](./CLAUDE.md) is the working agreement for this repository — architecture
boundaries, testing expectations, and the conventions that keep it consistent. It applies
to human contributors just as much as to Claude Code sessions.
