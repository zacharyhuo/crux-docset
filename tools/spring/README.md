# Experimental Spring build inputs

The fixed-version adapter is registered but the Spring recipe remains disabled.
Current scope: Spring Framework 7.0.9, reviewed commit, macOS arm64 only.
This is not redistribution approval or permission to enable publication.

## Enforced inputs

- `toolchain-lock.json`: full source-tree digest, JDK/Node archives, Gradle,
  reference renderer/UI, Dokka frontend output hashes and external metadata.
- `build-inputs-baseline.json`: six source configuration/Wrapper hashes. This
  remains a partial file baseline: full-tree acquisition is a separate gate.
  Prepared Wrapper content adds only the pinned distribution checksum.
- `gradle-verification-metadata.xml`: 1,749 artifacts, enforced in strict mode.
  Initial HTTPS-observed digests are not publisher-signature authentication.
- `reference/`: fixed npm lock and single-commit Antora configuration extension;
  no upstream collector execution or multi-version playbook.
- `external-metadata/`: 20 checked local metadata snapshots; builds must not
  silently fetch floating documentation indexes. Some original link destinations
  retain upstream `latest`/`release` URLs; these are not claimed as version pins.
- `dokka-frontend-integrity.json`: nine same-version lock supplements. Search
  and UI-kit JS/CSS rebuilt from the qualified source match generated assets.
  This is frontend provenance evidence, not a complete shipped-component audit.

The adapter fingerprints this entire directory through the common CLI. It
downloads and validates tools into private scratch, never installs globally,
builds fixed tasks with an explicit environment, exports all three documentation
sections and preserves bounded failure diagnostics in candidate quarantine.
The common pipeline owns icons, validation, archives and local revision state.

## Verification boundary (2026-10-05)

The source/tool probe passed a strict empty-Gradle-cache build and an offline
hot rerun. Its newly assembled candidate passed structural validation with
11,475 pages and 42,741 symbols. The formal reference renderer also passed.

After the user addressed the external stop and authorized continuation, the
formal CLI completed a fresh source/tool acquisition and empty-cache build:
API 474.90 seconds, reference render 6.48 seconds, complete pipeline 658.97
seconds. Validation passed: 11,475 pages, 42,741 symbols, no errors/warnings.
The immediate identical-input CLI invocation returned `unchanged` in 0.02
seconds without compiler work. Recorded release fingerprint:
`fb06a87116d5875fb2ebadbc491963c6ee4942add833a6353e2476a7fd0446e9`.

CLI regression fixtures additionally verify nested tool-input fingerprinting.
A separate real-bundle packaging experiment changed the packaging identity,
verified same-version revisions 1 then 2 and subsequent `unchanged`, and read
the archive metadata independently to verify version/revision/releaseId and
SHA-256. This packaging experiment reused the successful CLI docset; it did
not claim to recompile Spring for each revision or prove byte-identical builds.

Notice packaging is now wired after bundle assembly. Recipe-side catalogs are
fingerprinted, 49 exact license/NOTICE texts plus an index are added exclusively
to the new candidate, and the entire Documents tree is independently compared.
Generated attribution stays reviewed:false; integrity success is not approval.
The real cold output was repackaged and archive-readback tested with five negative
mutations in `.work/spring-notice-qualification-v1/result.json` (no compiler rerun).

New-artifact local Beta acceptance passed on 2026-10-05: real revision 1/2 archives,
single-slot replacement and failed-update preservation, full installed Documents
hash checks, and offline Javadoc/Dokka/reference interactions. Client Core137/137,
Beta app-hosted57/57, no skips. Transport was an isolated fixture, not public HTTPS.
The client fix preserves canonical supply bundleName independently of display name.
See `docs/experiments/SPRING-NOTICE-BETA-2026-10-05.md` for the evidence pointer.

Remaining: independent full attribution/license review and
publication gates; additional source versions/platforms. Documentation/status
updates after this qualification also enter the conservative tool-directory
fingerprint; the saved release identifies its exact tested inputs.

Timeout cleanup now inventories the owned descendant tree before terminating
the wrapper, including separate sessions. It waits for TERM/KILL cleanup and
checks the captured PID birth identity before signaling descendants. A real
stopped, detached Node child regression failed before the fix and passes after
it. This is cleanup for trusted build tools, not containment of hostile daemons.
Earlier stopped-process failures remain in quarantine as diagnostic history.
No resume signal or security bypass was used for the successful retry. This
completes fixed-version local build qualification, not release approval.
