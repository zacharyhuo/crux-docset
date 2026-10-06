# Offline notice evidence

`dokka-2.1.0.json` retains exact license text, SHA-256 references and npm archive
integrity for 82 components found in emitted Dokka frontend modules (79 search,
3 UI-kit), plus 10 shipped font files matched to their source packages. License
texts are deduplicated by bytes, not by declared SPDX label. Original license
metadata is retained, including the older object-shaped Combokeys declaration.

The source is Dokka commit `905286d0d31f143bf0627656db1f14ea56fa42d3`.
Source-locked frontend rebuilds matched the four JS/CSS hashes recorded in
`tools/spring/toolchain-lock.json`. Local qualification compared package files,
notice text and font bytes with the same-version integrity-complete npm install.
Webpack stats hashes identify the captured emitted-module inventories; build
loaders and unused modules are not treated as shipped components.

`assets-7.0.9.json` adds exact Dokka LICENSE/NOTICE and
[Prism 1.29.0 license](https://github.com/PrismJS/prism/blob/v1.29.0/LICENSE),
123 fixed-output non-HTML resource hashes and four HTML path-set digests. Its
baseline is the authenticated cold CLI build `fb06a871…` (full release ID in the
records). 50 Dokka resources also retain commit/blob source-byte matches.
Other `qualified-fixed-toolchain-output` records deliberately identify their
capture provenance, **not** independently established ownership or legal terms.
Prism JS/CSS are the Dokka-patched copies; their hashes are not represented as
pristine Prism upstream hashes. JDK resources retain the original bundled terms,
including jQuery, jQuery UI and DejaVu/Bitstream/Arev notices.

The adapter now consumes both catalogs, and fingerprints this directory.
`src/spring/notices.js` first checks catalog text hashes, font references, every
non-HTML resource hash and the exact HTML path inventory. A new version/resource
requires re-qualification; there is no extension-based unknown-file bypass.
HTML content is fingerprinted in the resulting manifest, but a path-set check
alone does not authenticate its content: upstream source/export validation is
still required. These APIs accept trusted immutable local candidates, not uploads.

Only a fresh candidate receives `Documents/licenses/crux-third-party/` (49 exact
license/NOTICE texts plus INDEX.txt). Existing notices stay byte-identical.
`Contents/Resources/spring-assets/manifest.json` covers **every Documents file**;
`report.json` records separate `integrityPassed` and `releaseQualified` results.
Both files and all notices are included in the docset archive. HTML attribution
records mixed Spring content, generator and Crux adaptation provenance; it does
not relicense Spring content under JDK/Dokka terms. Crux's own redistribution
license is not yet declared in this repository and is explicitly unspecified.

This is provenance data, **not a complete legally reviewed SBOM or approval**.
Every generated component remains `reviewed:false`. The independent `audit-assets`
command therefore exits 1 even for an intact candidate, listing review requirements;
missing/changed files produce additional failures. Local packaging accepts only
that exact review-only result and throws on any integrity error. A trusted release
authority must independently review component scope/embedded template and snippet
attribution and bind any approved manifest to the exact artifact. Do not flip all
flags to true or enable the variant just to make the audit green. No publication
authorization, trademark clearance, or new Beta GUI acceptance is implied.

2026-10-05 qualification: fresh copy of genuine CLI output through the production
notice packager and common validation/archive pipeline; archive readback scans
11,648 files, 11,475 HTML pages and 42,741 symbols. Five archive-copy mutations
(missing page/license, changed license/resource, unknown file) are rejected.
Detailed local evidence: `.work/spring-notice-qualification-v1/result.json`.
No Java/Kotlin compiler rerun was needed for this packaging-only acceptance.
