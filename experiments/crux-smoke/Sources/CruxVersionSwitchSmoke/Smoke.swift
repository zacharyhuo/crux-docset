import Foundation
import CruxCore

/// Local acceptance harness, NOT a publisher or network-download test. Inputs
/// are two real candidate directories. All installed state is newly allocated.
@main
struct VersionSwitchSmoke {
    static func main() async throws {
        guard CommandLine.arguments.count == 3 else {
            throw SmokeFailure("Usage: CruxVersionSwitchSmoke PYTHON_313_RELEASE_DIR PYTHON_314_RELEASE_DIR")
        }
        let old = try Candidate(directory: CommandLine.arguments[1], line: "3.13")
        let latest = try Candidate(directory: CommandLine.arguments[2], line: "3.14")
        let entry = try catalogEntry(old: old, latest: latest)
        let latestTarget = try DocsetInstallTarget(entry: entry)
        let oldTarget = try DocsetInstallTarget(entry: entry, selection: .pinnedRelease(old.manifest.releaseId))

        // Never accept a caller-supplied library path, preferences or bookmarks.
        let root = FileManager.default.temporaryDirectory.appending(path: "crux-version-smoke-\(UUID())")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        print("ISOLATED_ROOT \(root.path)")
        let database = root.appending(path: "registry.sqlite")
        let library = root.appending(path: "Docsets")
        let registry = try DocsetRegistry(databaseURL: database)
        let transaction = DocsetReplacementTransaction(registry: registry, docsetsDirectory: library)
        // Reuse the search service to catch stale handles after replacing a file
        // at the same path, not just whether a new service reads a fresh bundle.
        let search = SymbolSearchService()
        var previous: InstalledDocset?
        for (candidate, target) in [(latest, latestTarget), (old, oldTarget), (latest, latestTarget)] {
            let installed = try await transaction.perform(target: target, artifactAt: candidate.archive, existing: previous)
            try require(installed.descriptor.version == candidate.manifest.version, "Installed wrong version")
            try require(installed.descriptor.revision == candidate.manifest.revision, "Installed wrong revision")
            try require(!installed.descriptor.isJavaScriptEnabled, "Unexpected Python JavaScript policy")
            try require(installed.installTarget == target && installed.selectionPolicy == target.selectionPolicy,
                        "Policy or immutable target not committed")
            if let previous {
                try require(previous.descriptor.bundleURL == installed.descriptor.bundleURL, "Created another installation slot")
            }
            try await verifySingleInstallation(installed, database: database, library: library)
            for symbol in ["list", "dict", "asyncio"] {
                let results = try await search.search(symbol, in: [installed.descriptor], limit: 100)
                guard let exact = results.first(where: { $0.name == symbol }) else {
                    throw SmokeFailure("Missing exact symbol: \(symbol)")
                }
                let html = try String(contentsOf: exact.documentURL, encoding: .utf8)
                try require(!html.isEmpty, "Unreadable offline document: \(symbol)")
            }
            // Inspected real source indexes: this API is present in 3.14 and
            // absent in 3.13. It detects leaked newer-version search results.
            let added = try await search.search("pathlib.Path.copy", in: [installed.descriptor], limit: 100)
                .filter { $0.name == "pathlib.Path.copy" }
            try require(added.count == (candidate.manifest.versionLine == "3.14" ? 1 : 0),
                        "Search retained a stale version's symbols")
            print("PASS \(candidate.manifest.version) r\(candidate.manifest.revision): one bundle/record, persisted policy, offline searches, correct version-specific symbol")
            previous = installed
        }
        guard let previous else { throw SmokeFailure("No installation") }
        do {
            _ = try await transaction.perform(target: oldTarget, artifactAt: latest.archive, existing: previous)
            throw SmokeFailure("Wrong archive unexpectedly replaced installed version")
        } catch DocsetReplacementError.artifactMismatch {
            print("PASS wrong archive rejected before replacement")
        }
        try await verifySingleInstallation(previous, database: database, library: library)
        try require(try DocsetParser().parse(bundleAt: previous.descriptor.bundleURL) == previous.descriptor,
                    "Failed replacement changed installed contents")
        print("PASS failed replacement preserves latest files and policy")
        print("LOCAL_ONLY: no GUI, HTTPS, published-state or remote availability claim. Temporary evidence retained at \(root.path)")
    }

    static func verifySingleInstallation(_ expected: InstalledDocset, database: URL, library: URL) async throws {
        let reopened = try DocsetRegistry(databaseURL: database)
        try await DocsetReplacementTransaction(registry: reopened, docsetsDirectory: library).recoverPending()
        let scan = try await reopened.scanAndRegister(docsetsDirectory: library)
        try require(scan.failures.isEmpty, "Restart scan failed")
        try require(try await reopened.allInstalled() == [expected], "Restart did not preserve exactly one record and policy")
        let visible = try FileManager.default.contentsOfDirectory(at: library, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles])
        try require(visible.filter { $0.pathExtension == "docset" }.count == 1, "Multiple visible bundles")
    }

    private static func catalogEntry(old: Candidate, latest: Candidate) throws -> CatalogEntry {
        // Only an in-memory contract fixture. Reserved .invalid URLs must never
        // be put into a real catalog; the transaction receives a local archive.
        let fixture: [String: Any] = ["schemaVersion": 1, "families": [[
            "sourceId": "dev.crux", "familyId": "python", "title": "Python",
            "identifier": "dev.crux.python", "bundleName": "Python",
            "defaultVariantId": latest.manifest.variantId, "latestReleaseId": latest.manifest.releaseId,
            "releases": [old, latest].map { candidate -> [String: Any] in
                let m = candidate.manifest
                return ["releaseId": m.releaseId, "variantId": m.variantId, "versionLine": m.versionLine,
                        "language": m.language, "version": m.version, "revision": m.revision, "identifier": m.identifier,
                        "publishedAt": m.builtAt, "channel": "stable", "support": "supported",
                        "artifact": ["url": "https://local-smoke.invalid/\(m.releaseId)/Python.tgz",
                                     "sha256": m.artifact.sha256, "bytes": m.artifact.bytes]]
            },
        ]]]
        let provider = CatalogProvider.versioned(catalogURL: URL(string: "https://local-smoke.invalid/catalog.json")!, sourceId: "dev.crux")
        let entries = try CatalogEntry.parseList(JSONSerialization.data(withJSONObject: fixture), provider: provider)
        guard entries.count == 1, let entry = entries.first else { throw SmokeFailure("Invalid test catalog") }
        return entry
    }
}

private struct Candidate {
    let manifest: Manifest
    let archive: URL

    init(directory: String, line: String) throws {
        let root = URL(fileURLWithPath: directory, isDirectory: true)
        let data = try Data(contentsOf: root.appending(path: "manifest.json"))
        try require(data.count <= 65_536, "Oversized candidate manifest")
        manifest = try JSONDecoder().decode(Manifest.self, from: data)
        try require(manifest.schemaVersion == 2 && manifest.familyId == "python" && manifest.sourceId == "dev.crux"
                    && manifest.identifier == "dev.crux.python" && manifest.bundleName == "Python"
                    && manifest.language == "en" && manifest.versionLine == line
                    && manifest.version.hasPrefix(line + ".") && manifest.artifact.file == "Python.tgz"
                    && manifest.validation.passed, "Not a validated candidate in the expected Python line")
        archive = root.appending(path: "Python.tgz")
    }
}

private struct Manifest: Decodable {
    let schemaVersion: Int
    let sourceId, familyId, variantId, versionLine, language, identifier, bundleName, releaseId, version, builtAt: String
    let revision: Int
    let artifact: Artifact
    let validation: Validation
    struct Artifact: Decodable { let file, sha256: String; let bytes: Int64 }
    struct Validation: Decodable { let passed: Bool }
}

private struct SmokeFailure: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

private func require(_ condition: Bool, _ message: String) throws {
    guard condition else { throw SmokeFailure(message) }
}
