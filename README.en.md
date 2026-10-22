# crux-docset

[English](README.en.md) | [简体中文](README.md)

Crux's independent docset supply repository. The Node.js CLI, official Python documentation builds, validation, and GitHub Release publishing workflow are implemented, with private releases recorded on `main`. Public anonymous downloads still require acceptance testing; the repository is currently private.

This repository contains recipes, build adapters, license records, quality tests, upstream change detection, version locking, and automated publishing.

- [Crux consumer contract](contracts/crux-consumer.md): versioned catalogs, immutable artifacts, integrity checks, and public acceptance criteria.
- [Python publishing and recovery](publication/README.md): the existing main-branch publishing workflow, permissions, and recovery from interruptions.
- [Recipe configuration](recipes/python/recipe.json) and [publication policy](publication/python.json): the current default Python supply line.
- [Spring build tools](tools/spring/README.md): experimental local builds and qualification limits.
- [Crux client](https://github.com/zacharyhuo/Crux) and [backend service repository](https://github.com/zacharyhuo/crux-server).

Git stores recipes and small metadata files. Generated `.tgz` archives and SQLite/HTML bundles are published to GitHub Releases or object storage. Changes to recipes, adapters, and permission policies require human review; bots publish routine content updates that pass the established checks.

The client implements independent source settings and has passed isolated native Beta acceptance tests, with Crux enabled and Zeal disabled by default. Crux's `schemaVersion: 1` catalog and Zeal's raw JSON array use separate protocols. Zeal retrieves archives through `/d/{sourceId}/{name}/latest`; version labels alone cannot establish exact-version availability.
Private repositories require authentication. Tokens must never be embedded in the client, catalog, or feeds. Authenticated server-side read-back checks and Beta tests through a local TLS relay do not replace public anonymous HTTPS acceptance testing.

## Getting started

Requires Node.js 24+, npm, and uv; tests also require `zip`. Java, Docker, a database service, and Dash are not required. uv uses `tools/doc2dash/uv.lock` and creates a Python 3.11 virtual environment inside the project directory when needed.

```sh
npm ci --ignore-scripts
npm test
npm run docset -- list
npm run docset -- build
```

The last command discovers the stable offline HTML archive for the **Python 3.14 release line** on Python's official website, downloads it, and computes its hash. It does not move to another minor release line. On success, it prints a candidate directory containing a `.tgz` archive, `manifest.json`, `source-lock.json`, `validation.json`, and an inspectable `.docset` bundle. Repeating the command with unchanged inputs skips the build. All generated files stay in the ignored `.work/` directory, outside Git.

## Release lines and working directories

`list` shows each family/variant, defaults, and `implemented`/`buildable` status. Automated supply is currently enabled for the default Python release line. Experimental Go/Spring adapters and disabled release lines do not enter automated publishing. Adding a release line requires review of `recipes/<family>/variants/<variantId>.json`; a new upstream version alone cannot enable it.

```sh
node src/cli.js build --id python --variant python-3-14-en
node src/cli.js build --id python --variant python-3-13-en
node src/cli.js matrix --id python
node src/cli.js build --id python --archive /absolute/path/python-docs.zip --work /absolute/path/new-work
node src/cli.js validate --id python --bundle /absolute/path/Python.docset
```

Variants in the same family share a stable bundle identifier (`dev.crux.python` for Python) but maintain separate build state. The default directory is `.work/<variantId>`; Python 3.14 retains an explicit compatibility mapping to `.work/python`. `--work` is the state root for one variant. The CLI checks `owner.json` under the lock and prevents another release line from taking ownership. It will not clean or overwrite an unknown nonempty directory.

The current candidate matrix contains Python 3.14 (default) and 3.13. Both stay within their minor release lines when discovering updates. `matrix` only prints reviewed configurations that are enabled and have an implemented adapter; it does not download, build, or publish. Each build resolves the exact archive and hash under its lock. `.github/workflows/version-candidates.yml` supports manual dispatch only, with at most two parallel jobs, a 20-minute limit per job, and no cancellation of other jobs after a failure. Runs consume private-repository Actions quota; no scheduled trigger has been added. A successful candidate build does not establish public download availability or Beta GUI acceptance.

Python may change page layouts within a release line. Required-body rules can use `paths` to list up to four verified equivalent paths, mutually exclusive with the single `path` field. At least one real page must still contain the same required body text; redirect placeholders do not qualify. Current rules handle the built-in functions documentation moving from `library/` to `builtins/`, without changing old packages or lowering count thresholds.

Schema-2 state stores the version and fingerprint in the `release` field of `current.json`; older CLIs refuse to read or write it. Before migration, verified schema-1 Python 3.14 state is backed up as `legacy-current.v1.json`, and existing immutable artifacts remain unchanged. If the source, actual bundle, or release line cannot be verified, inspect it manually or rebuild in a new directory. Do not delete owner/current files to bypass ownership checks. Actions uses a new v2 cache key and does not restore old v1 caches that lack a complete bundle.

Local builds generate candidate feeds only when you explicitly set `--base-url https://<configured-artifact-root>`. The layout is `artifacts/<variantId>/<fingerprint>/<Bundle>.tgz` and `feeds/<variantId>.xml`. This is neither a direct GitHub Release URL construction rule nor proof of an upload. The GitHub publisher uploads and reads back artifacts separately, then generates catalogs and feeds with real Release download URLs.

## Exact-version catalogs and publication state

`src/release-catalog.js` provides `makeReleaseCatalog(records, latestByFamily)` and strict `validateReleaseCatalog(catalog)` validation. Keys in `latestByFamily` use `sourceId/familyId`, and values are reviewed release IDs. Catalogs contain only `published` entries. The latest pointer must reference a `supported` stable release on the default supply line. Historical entries can be marked `archived`; users can still download them explicitly, but they are no longer recommended automatically. Candidate and withdrawn entries do not appear in the selection list. An invalid or missing latest pointer causes the entire update to be rejected, without guessing a replacement.

See the [consumer contract](contracts/crux-consumer.md) for the full fields and selection rules. Versions and `example.invalid` URLs in the schemaVersion 1 [contract fixture](test/fixtures/version-catalog/v1.json) are for protocol tests only and do not represent real supply. The [matching client fixture](https://github.com/zacharyhuo/Crux/blob/develop/v1/Packages/CruxCore/Tests/ContractFixtures/version-catalog-v1.json) must remain byte-for-byte identical. Both files have SHA-256 `097af598938773ab257a30b09640ce2d26b6ee0c84530053b24801db7d391586`.

`src/published-store.js` provides a local persistent-state API for use by an independent publisher:

- `reserveRevision(directory, identity, { minimumRevision })`: reserves revisions serially per variant/version. Calls with the same releaseId are idempotent; losing the build cache does not allocate another revision.
- `recordPublished(directory, record)`: requires an existing reservation with matching identity. It reads uploaded files back over HTTPS and verifies their full hashes and sizes before recording publication. It does not upload files or replace independent docset content validation.
- `writePublishedCatalog(directory, latestByFamily)`: generates the catalog from persistent records, committing an intent snapshot before atomically replacing `catalog.json`.
- `recoverPublishedCatalog(directory)`: recovers the final catalog-file write. `withdrawPublishedRelease(directory, releaseId, latestByFamily)` requires an explicit, consistent replacement recommendation policy and cannot revive the original releaseId.

Build with `--publication-state /absolute/path/durable-publication` to use these reservations. This directory must be separate from `--work` and must not be treated as an Actions cache. Without this option, builds remain local candidates and do not create published records. Locks protect only the same directory. The GitHub publisher persists state on a separate `docset-publication` branch, commits against the original head, and forbids forced updates to prevent concurrent overwrites.

## Automated Python supply on GitHub

See the [operation and recovery guide](publication/README.md). `.github/workflows/python-candidate.yml` connects read-only state recovery, a default Python candidate build, independent archive revalidation, and a separate publishing job with write permission. Builds and publication run only on `main`; PRs and `develop/v1` do not publish. The version-candidate matrix remains a manual build workflow.

`publication/python.json` pins the effective recipe and icon digests. Rule changes require updates through code review; official patch/content updates within the same release line do not require individual human approval. The publisher extracts the archive again, validates every indexed target and the version/revision inside the archive, and generates `qualification.json` binding the artifact, recipe, builder, source-lock, and reports. It accepts only official Python sources. This process does not approve Spring's unreviewed manifests.

The package and four evidence files are uploaded to a separate GitHub Release. Uploaded assets are never overwritten or deleted. After upload, the publisher streams them back to verify their complete SHA-256 hashes and byte counts. For public repositories, it also verifies credential-free download URLs. Private development uses a server-side Actions token to read back the same assets; catalogs contain neither tokens nor temporary signed parameters. The publisher then updates state, catalog, feeds, and validation evidence in a single Git commit, preserving the old catalog on failure. Unchanged inputs that have already been published skip upload, and interrupted uploads can resume on a new runner.

The private main-branch acceptance record dated 2026-10-06 documents real Actions releases of Python 3.14.7 r1 and 3.13.16 r1, with catalog/feed files on `docset-publication` and 3.14 still the default recommendation. Repeating the same inputs skipped the publisher; the publication branch head and the IDs/digests of all five assets remained unchanged. The repository default branch was set to `main`. Daily updates supply only the default line, while manual runs can select the reviewed 3.13/3.14 lines. Local development continues on `develop/v1`.

Beta has passed HTTPS installation, version replacement, pinning an older version, corrupt-package rejection, and recovery tests using real GitHub Release packages verified by SHA-256 and byte count. Because the repository is private, these tests used authenticated GitHub CLI downloads served through a local TLS relay. The client held no token. This verifies the real release packages, but public anonymous CDN downloads still require acceptance testing.

The CLI and validators use JavaScript; doc2dash is a locked upstream Python build tool. A Java + Spring backend is planned for `crux-server`, with no service implementation yet. This stage does not require a long-running service. A local generation agent also remains on the client roadmap; the existing CLI builder does not mean that agent is complete.

## Offline asset license manifest audit (independent check)

```sh
node src/cli.js audit-assets --documents /absolute/path/Contents/Resources/Documents --manifest /absolute/path/reviewed-assets.json
```

This read-only local command requires no registered adapter, network access, dependency installation, build, or publication. It checks the entire Documents tree, including HTML, pages containing inline scripts, and extensionless files, comparing SHA-256 hashes file by file. Unknown or missing files, content drift, unreviewed components, missing or unassigned license files, and symbolic links return exit code 1. Success returns 0. It reports at most the first 100 errors, while `errorCount` retains the actual detected count; scanning stops when resource limits are reached.

Manifest format: `schemaVersion: 1`. Each entry in `components` contains `id`, `version`, an HTTPS `source`, `reviewed: true`, `license`, and `notices` (an array of paths relative to Documents). Each entry in `files` contains `path`, a lowercase SHA-256 `sha256`, and `components` (which can contain multiple component IDs). Each notice must also appear in `files` as a nonempty file with the correct ownership and digest. See `test/asset-audit.test.js` for a complete runnable example.

**Trust boundary:** the manifest requires independent review. Do not generate it from the package under review and immediately mark it reviewed. The tool checks consistency between the manifest and files. It cannot detect undeclared third-party components within bundles, determine license compatibility, verify the provenance claimed by URLs, or grant trademark rights. Callers must keep inputs immutable; this is not a sandbox for extracting untrusted archives. The Spring local builder includes byte-integrity checks, but generated manifests remain `reviewed:false`, so the independent audit rejects them for publication qualification. A license-approval gate has not yet been integrated into the general publisher. A successful local build alone must not enable Spring publication. Page digests can be generated automatically; component approval cannot.

## Recipe icon assets

Each recipe's sibling `assets/` directory contains `icon.png` (16×16), `icon@2x.png` (32×32), and source/trademark notes. Builds read these files offline and copy them into the docset root. Icon contents are part of the build fingerprint, so replacing an icon triggers a rebuild. The Python recipe sets `validation.requireIcons: true` and checks for missing files, file type, size limits, PNG decoding/CRC, and dimensions using the locked `pngjs` dependency. See the [Python assets notes](recipes/python/assets/README.md) for the original image and its source.

The official Spring Framework icons and source records are documented in [Spring assets](recipes/spring-framework/assets/README.md). The English 7.0 recipe remains disabled. The experimental `spring-framework` adapter is registered and accepts only the reviewed pinned commit for 7.0.9, currently limited to macOS arm64. Source retrieval, tool preparation, Java/Kotlin API and reference documentation builds, offline export, and combined packaging are connected. All inputs under `tools/spring` contribute to the CLI fingerprint.
The full CLI cold build and a rerun with identical inputs have passed: 11,475 pages, 42,741 symbols, and zero validation errors or warnings. Revision increments for the same version and consistency of metadata inside real archives have also been verified.
This completes only the local build stage for the pinned version and does not authorize automated supply or publication. Third-party notice packaging and full file-tree comparison are integrated; a new real candidate passed packaging/extraction checks and tampering rejection tests. Complete license attribution approval, publication gates, other versions, and other execution platforms still require separate work.
Verified Dokka components and license texts are stored in the [notice source data](recipes/spring-framework/notices/README.md) and contribute to the builder fingerprint alongside the pinned resource manifest. Passing local byte validation does not establish complete license review.

Actions PR/build jobs remain read-only. The separate publisher job on `main` uses `contents: write` to create Releases and commit the supply catalog. No scheduled builds for other technology stacks have been added at this stage. Client code, generated documentation, third-party test fixtures, and icons each have their own rights and licensing boundaries. Changes to Crux's license do not change this repository's or upstream content's terms.
