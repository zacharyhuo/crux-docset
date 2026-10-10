# Crux docset consumer contract

This contract describes the versioned catalog produced by crux-docset and read by
CruxCore. It is separate from the [Zeal raw-array contract](https://github.com/zacharyhuo/crux-server/blob/develop/v1/contracts/zeal-compatible-catalog.md).
The new Crux source model defines Crux enabled and Zeal disabled by default;
settings integration has passed isolated native Beta acceptance. A source being
enabled does not establish that its public hosting is ready.

## Catalog and immutable artifacts

The top level is a JSON object with exactly `schemaVersion: 1` and `families`.
It is not a raw array or a wrapper around Zeal entries. The producer validates it
in [release-catalog.js](../src/release-catalog.js); the client validates it in
[VersionedCatalog.swift](https://github.com/zacharyhuo/Crux/blob/develop/v1/Packages/CruxCore/Sources/CruxCore/VersionedCatalog.swift).

| Object | Fields |
| --- | --- |
| Family | `sourceId`, `familyId`, `title`, `identifier`, `bundleName`, `defaultVariantId`, `latestReleaseId`, `releases` |
| Release | `releaseId`, `variantId`, `versionLine`, `language`, `version`, `revision`, `identifier`, `artifact`, `publishedAt`, `channel`, `support` |
| Artifact | `url`, `sha256`, `bytes` |

The [shared fixture](../test/fixtures/version-catalog/v1.json) shows the full wire
shape, including supported and archived releases. Its `example.invalid` URLs,
hashes and byte counts are synthetic protocol data, not downloadable supply.
The [client copy](https://github.com/zacharyhuo/Crux/blob/develop/v1/Packages/CruxCore/Tests/ContractFixtures/version-catalog-v1.json)
must remain byte-identical when the contract changes.

`sourceId` identifies the supplier; the current recipes use `dev.crux`.
`familyId` identifies a documentation family, such as `python`. `variantId`
identifies a reviewed version/language line, such as `python-3-14-en`.
The family `identifier` remains stable across its releases. `bundleName` is the
filesystem-safe canonical name, which can differ from the displayed title.

`releaseId` is a 64-character lowercase hexadecimal identity. A release has a
positive revision and a version within its declared version line. The current
profile accepts English stable releases, with `support` set to `supported` or
`archived`, and an ISO 8601 UTC publication timestamp with milliseconds.
Family, bundle, release and revision identities must not collide. Unknown or
missing fields are rejected by the current client profile; extensions require a
coordinated schema change.

Artifact URLs use canonical HTTPS without credentials, query parameters or a
fragment. `sha256` is the lowercase hash of the complete compressed artifact;
`bytes` is its exact compressed byte count. Both are required. An artifact URL
identifies immutable bytes, not a moving repository-wide `latest` download.
Consumers allow HTTPS redirects and reject plaintext downgrades. The separate
local-HTTP source policy in Crux does not relax this versioned
artifact URL contract.

## Selection and replacement

Only published records enter the catalog. Reserved, candidate and withdrawn
records remain outside it. A family's `latestReleaseId` must resolve to a listed,
supported release in `defaultVariantId`; consumers must not guess a replacement
pointer from version ordering. Archived releases remain selectable by explicit
release identity and do not become the default recommendation.

A consumer resolves either latest or a pinned release to the exact artifact.
Legacy Zeal entries cannot acquire exact-version selection from their `versions`
labels alone. The client verifies the full artifact hash and byte count before
activation, then checks the parsed bundle against the chosen source/family,
variant, release, version/revision, identifier and canonical bundle name.
Matching `meta.json` claims alone are not proof of origin or installation ownership.

The expanded bundle contains `Contents/Info.plist`,
`Contents/Resources/docSet.dsidx` and `Contents/Resources/Documents`. Supply
metadata in root `meta.json` carries `sourceId`, `familyId`, `variantId`,
`versionLine`, `language`, `identifier`, `bundleName` and `releaseId`, alongside
the bundle's ordinary version/revision metadata. Preserve upstream notices and
the recipe's required icons/content. Crux replaces the existing family in the
same installation slot through its recoverable transaction; installing a different
version is not a request for a second independent family slot.

An invalid refresh must not activate a partial catalog or silently choose a
different release. Keep the last accepted source cache available for offline use.
Source configuration and cache identity must remain separate across providers.
The user's source-configuration UUID is separate from the publisher's `sourceId`;
matching family names from different configured endpoints do not establish shared
ownership. Disabling a source is not an instruction to delete installed documentation.

## Dash feeds

The publisher also produces Dash XML feeds for compatible consumers. A feed
offers version/revision and archive URLs; it does not encode this catalog's full
family/release selection and integrity contract. Consumers that need pinned
releases use the versioned catalog. Application Sparkle appcasts are a separate
format and do not belong in this pipeline.

## Publication and acceptance

The Python publisher uploads immutable Release assets, reads them back, checks
hash/size and activates catalog/feed state only after qualification. Build and
publication jobs run on `main`; PR and `develop/v1` work does not publish. The
candidate matrix remains a separate manual workflow. See the tracked
[publication guide](../publication/README.md) for recovery and permission details.

The intended catalog location is
`https://raw.githubusercontent.com/zacharyhuo/crux-docset/docset-publication/catalog.json`,
with the Python feed at the same root under `feeds/python.xml`. These are intended
consumer locations, not evidence of anonymous availability. The repository's
2026-10-06 record covers real private Release assets and isolated Beta acceptance
through an authenticated download plus a local TLS relay. Public anonymous HTTPS
catalog/feed/archive downloads still need acceptance after hosting permits them.

Clients must not embed GitHub credentials or treat an authenticated server-side
asset readback as anonymous consumer acceptance. Catalog hashes validate bytes;
the source operator still needs rights to distribute the pages, code examples
and bundled artwork. Spring's local builds and byte audits do not authorize its
automatic publication. No Java backend is required or implemented by this contract.

Before public rollout, verify the anonymous catalog and feed, all advertised
artifact bytes and HTTPS redirects, and latest/pinned/replacement behavior in
Crux Beta with disposable data. A fixture-gated test that skips does not complete
that acceptance. Keep production Crux and sibling repository license decisions
outside the test and publication contract.
