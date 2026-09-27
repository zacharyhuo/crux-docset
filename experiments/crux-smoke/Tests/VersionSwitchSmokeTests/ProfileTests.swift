import Foundation
import Testing
import CruxCore
@testable import CruxVersionSwitchSmoke

@Test func legacyPythonAndExplicitGoSelectTheirOwnCandidateLines() throws {
    let python = try SmokeInvocation(arguments: ["old", "latest"])
    #expect(python.profile == .python)
    let go = try SmokeInvocation(arguments: ["--profile", "go", "old", "latest"])
    #expect(go.profile == .go)
    #expect(go.oldDirectory == "old" && go.latestDirectory == "latest")
    for args in [["--profile", "java", "old", "latest"], ["--profile", "go", "old"],
                 ["--profile", "go", "old", "latest", "existing-library"], ["--library", "production"]] {
        #expect(throws: (any Error).self) { try SmokeInvocation(arguments: args) }
    }
}

@Test func goCandidatesProduceOneFamilyAndExplicitLatestOrPinnedTargets() throws {
    let root = try fixtureRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let oldURL = try putManifest(root, name: "old", line: "1.26", version: "1.26.8")
    let latestURL = try putManifest(root, name: "latest", line: "1.27", version: "1.27.1")
    let old = try Candidate(directory: oldURL.path, line: "1.26", profile: .go)
    let latest = try Candidate(directory: latestURL.path, line: "1.27", profile: .go)
    let entry = try VersionSwitchSmoke.catalogEntry(old: old, latest: latest, profile: .go)
    let defaultTarget = try DocsetInstallTarget(entry: entry)
    let pinned = try DocsetInstallTarget(entry: entry, selection: .pinnedRelease(String(repeating: "a", count: 64)))
    #expect(defaultTarget.release.id == String(repeating: "b", count: 64))
    #expect(pinned.release.id == String(repeating: "a", count: 64))
    #expect(defaultTarget.slotKey == pinned.slotKey && defaultTarget.slotKey == "dev.crux/go")
    #expect(latest.archive.lastPathComponent == "Go.tgz")
}

@Test func candidateValidationCannotBeBypassedBySelectingGo() throws {
    let root = try fixtureRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    for (i, changes) in [["familyId": "python"], ["identifier": "dev.crux.python"],
                         ["variantId": "go-1-26-en"], ["version": "1.28.0"],
                         ["artifact": ["file": "../Go.tgz", "sha256": String(repeating: "a", count: 64), "bytes": 42]],
                         ["validation": ["passed": false]]].enumerated() {
        let url = try putManifest(root, name: "bad-\(i)", line: "1.27", version: "1.27.1", changes: changes)
        #expect(throws: (any Error).self) { try Candidate(directory: url.path, line: "1.27", profile: .go) }
    }
}

private func fixtureRoot() throws -> URL {
    let root = FileManager.default.temporaryDirectory.appending(path: "crux-smoke-profile-test-\(UUID())")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
    return root
}

private func putManifest(_ root: URL, name: String, line: String, version: String, changes: [String: Any] = [:]) throws -> URL {
    let directory = root.appending(path: name)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
    var manifest: [String: Any] = ["schemaVersion": 2, "sourceId": "dev.crux", "familyId": "go",
        "variantId": "go-\(line.replacingOccurrences(of: ".", with: "-"))-en", "versionLine": line,
        "language": "en", "identifier": "dev.crux.go", "bundleName": "Go", "releaseId": String(repeating: name == "old" ? "a" : "b", count: 64),
        "version": version, "revision": 1, "builtAt": "2026-09-27T00:00:00.000Z",
        "artifact": ["file": "Go.tgz", "sha256": String(repeating: "a", count: 64), "bytes": 42],
        "validation": ["passed": true]]
    manifest.merge(changes) { _, replacement in replacement }
    try JSONSerialization.data(withJSONObject: manifest).write(to: directory.appending(path: "manifest.json"))
    return directory
}
