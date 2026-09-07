/**
 * Generates THIRD-PARTY-LICENSES.md — the notice document shipped inside the packaged
 * app (see electron-builder.yml's `files`).
 *
 * Why this is generated rather than hand-maintained: several of the licences WingLog
 * depends on require the licence text and copyright notice to be *reproduced* in
 * distributions (MIT, BSD-3-Clause, Apache-2.0, ISC), and LGPL-3.0 requires rather more
 * than that (see the node-simconnect section it emits). A hand-written list silently goes
 * stale the first time a dependency is added or bumped, and the failure mode is a
 * licence violation rather than a broken build.
 *
 * Run `npm run licenses:generate` after changing production dependencies, and commit the
 * result. Only `dependencies` are walked — devDependencies are build-time tooling and
 * don't ship. Electron itself is the exception and is covered by a hand-written note,
 * since electron-builder bundles its own licence files into the app already.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

interface PackageManifest {
  version?: string
  license?: string
  repository?: string | { url?: string }
  dependencies?: Record<string, string>
}

/** Licences that require their full text to be reproduced by anyone redistributing. */
const TEXT_REQUIRED = /^(MIT|ISC|BSD|Apache|LGPL|GPL|MPL)/i

function readManifest(path: string): PackageManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as PackageManifest
}

function repoUrl(repository: PackageManifest['repository']): string | undefined {
  const raw = typeof repository === 'string' ? repository : repository?.url
  if (!raw) return undefined
  // npm manifests use forms like "git+https://github.com/x/y.git" and "github:x/y".
  return raw
    .replace(/^git\+/, '')
    .replace(/\.git$/, '')
    .replace(/^github:/, 'https://github.com/')
}

/** Finds a package's bundled licence file — the filename is not standardised. */
function findLicenceText(dir: string): { filename: string; text: string } | undefined {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return undefined
  }
  const filename = entries.find((entry) => /^licen[cs]e/i.test(entry))
  if (!filename) return undefined
  try {
    return { filename, text: readFileSync(join(dir, filename), 'utf8').trim() }
  } catch {
    return undefined
  }
}

const HEADER = `# Third-party licences

WingLog itself is licensed under the GNU General Public License v3.0 — see
[\`LICENSE\`](./LICENSE). This document covers the third-party code and data distributed
*with* it, and the obligations that come with them.

**This file is generated** by \`npm run licenses:generate\` from the installed production
dependencies. Don't edit it by hand; edit \`scripts/generate-third-party-licenses.ts\`
and re-run.

---

## GNU LGPL v3.0: node-simconnect

WingLog's SimConnect layer depends on [node-simconnect][ns], which is licensed under
the **GNU Lesser General Public License, version 3 or later**. This is the one dependency
whose licence imposes obligations beyond attribution, so they're stated explicitly:

- **The library is used unmodified.** WingLog ships the published npm package as-is;
  no patches, no vendored fork.
- **It is dynamically loaded, not statically combined.** The build externalizes it
  (\`externalizeDepsPlugin\` in \`electron.vite.config.ts\`), so the packaged main process
  does a plain \`require("node-simconnect")\` at runtime.
- **It is replaceable.** The package is excluded from the app's asar archive
  (\`asarUnpack\` in \`electron-builder.yml\`), so it exists as ordinary files under
  \`resources/app.asar.unpacked/node_modules/node-simconnect/\` in an installed copy. A
  user may replace it with a modified or newer version of the library and run the result.
- **Corresponding source** for the exact version shipped is available from the upstream
  repository and from the npm registry, and on request from the copyright holder of
  WingLog at no charge.
- **The full LGPL v3.0 text** is reproduced below. LGPL v3.0 incorporates the terms of
  GPL v3.0 by reference; that text is in [\`LICENSE\`](./LICENSE).

[ns]: https://github.com/EvenAR/node-simconnect

`

const DATA_INTRO = `---

## Bundled data

Three reference datasets are vendored into the app. Their per-file provenance and terms
are reproduced verbatim below, from \`resources/*.LICENSE.txt\` in the source repository.

**Note on the airline database:** it is licensed under the Open Database License (ODbL)
1.0, which is share-alike **for the database**. It does not place WingLog's own source
code under ODbL, but the dataset itself — and any redistributed derivative of it — must
remain under a free/open licence, in any distribution of this app.

`

const DATA_FILES = [
  { title: 'Airports — OurAirports', path: 'resources/airports.LICENSE.txt' },
  { title: 'Airlines — OpenFlights (ODbL 1.0)', path: 'resources/airlines.LICENSE.txt' },
  {
    title: 'Aircraft type designators — ICAO Doc 8643 list',
    path: 'resources/icao-aircraft-types.LICENSE.txt'
  }
]

const RUNTIME_NOTE = `---

## Application runtime

WingLog is distributed as an [Electron](https://www.electronjs.org/) application.
Electron is MIT-licensed and embeds Chromium and Node.js, which carry their own licences;
electron-builder includes Electron's own licence files in the packaged application
alongside this document.

Airline logos shown in the interface are fetched at runtime from a third-party image
service and are not redistributed with this application. They remain the property of the
respective airlines.

`

function main(): void {
  const root = process.cwd()
  const manifest = readManifest(join(root, 'package.json'))
  const names = Object.keys(manifest.dependencies ?? {}).sort()

  const packages = names.map((name) => {
    const dir = join(root, 'node_modules', name)
    const pkg = readManifest(join(dir, 'package.json'))
    return {
      name,
      version: pkg.version ?? '(unknown)',
      license: pkg.license ?? '(unspecified)',
      url: repoUrl(pkg.repository),
      licence: findLicenceText(dir)
    }
  })

  const missing = packages.filter((p) => !p.licence && TEXT_REQUIRED.test(p.license))
  const sections: string[] = [HEADER]

  // node-simconnect's own bundled file is the LGPL text, so it doubles as the reproduction
  // the compliance section above promises.
  const simconnect = packages.find((p) => p.name === 'node-simconnect')
  if (simconnect?.licence) {
    sections.push(`### GNU Lesser General Public License v3.0\n\n\`\`\`\n${simconnect.licence}\n\`\`\`\n\n`)
  }

  sections.push('---\n\n## Dependencies\n\n| Package | Version | Licence |\n| --- | --- | --- |\n')
  for (const p of packages) {
    const link = p.url ? `[${p.name}](${p.url})` : p.name
    sections.push(`| ${link} | ${p.version} | ${p.license} |\n`)
  }
  sections.push('\n')

  for (const p of packages) {
    if (p.name === 'node-simconnect') continue // reproduced in full above
    sections.push(`### ${p.name} ${p.version} — ${p.license}\n\n`)
    if (p.licence) {
      sections.push(`\`\`\`\n${p.licence}\n\`\`\`\n\n`)
    } else {
      // Real case: drizzle-orm declares Apache-2.0 but ships no licence file.
      sections.push(
        `This package declares \`${p.license}\` in its manifest but does not ship a licence ` +
          `file.${p.url ? ` See ${p.url} for the applicable terms.` : ''}\n\n`
      )
    }
  }

  sections.push(DATA_INTRO)
  for (const file of DATA_FILES) {
    sections.push(`### ${file.title}\n\n\`\`\`\n${readFileSync(join(root, file.path), 'utf8').trim()}\n\`\`\`\n\n`)
  }

  sections.push(RUNTIME_NOTE)

  writeFileSync(join(root, 'THIRD-PARTY-LICENSES.md'), sections.join(''))

  console.log(`Wrote THIRD-PARTY-LICENSES.md for ${packages.length} production dependencies.`)
  if (missing.length > 0) {
    console.warn(
      `\nWarning: no licence file found for ${missing.length} package(s) whose licence ` +
        `normally requires the text to be reproduced:\n` +
        missing.map((p) => `  - ${p.name} (${p.license})`).join('\n') +
        `\nThese are listed with a pointer to their upstream terms instead. Check them.`
    )
  }
}

main()
