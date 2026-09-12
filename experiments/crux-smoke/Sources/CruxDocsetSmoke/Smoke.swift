import Foundation
import CruxCore

@main
struct Smoke {
    static func main() async throws {
        guard (3...4).contains(CommandLine.arguments.count) else {
            throw NSError(domain: "CruxSmoke", code: 1, userInfo: [NSLocalizedDescriptionKey: "Usage: CruxDocsetSmoke ARCHIVE NEW_INSTALL_DIRECTORY [FEED_XML]"])
        }
        let archive = URL(fileURLWithPath: CommandLine.arguments[1])
        let destination = URL(fileURLWithPath: CommandLine.arguments[2])
        guard !FileManager.default.fileExists(atPath: destination.path) else {
            throw NSError(domain: "CruxSmoke", code: 2, userInfo: [NSLocalizedDescriptionKey: "Destination must not exist; never use your real library"])
        }
        let descriptor = try await DocsetInstaller().install(artifactAt: archive, into: destination, expectedIdentifier: "dev.crux.python")
        guard descriptor.version == "3.14.7", !descriptor.isJavaScriptEnabled else {
            throw NSError(domain: "CruxSmoke", code: 3, userInfo: [NSLocalizedDescriptionKey: "Unexpected parsed metadata"])
        }
        if CommandLine.arguments.count == 4 {
            let feedData = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[3]))
            let feed = try DashFeedParser.parse(xml: feedData, feedURL: URL(string: "https://example.invalid/python.xml")!)
            guard feed.version == descriptor.version, feed.revision == descriptor.revision else {
                throw NSError(domain: "CruxSmoke", code: 6, userInfo: [NSLocalizedDescriptionKey: "Feed and installed metadata disagree"])
            }
            print("PASS feed parsing and installed version/revision consistency")
        }
        let search = SymbolSearchService()
        for symbol in ["list", "dict", "asyncio"] {
            let results = try await search.search(symbol, in: [descriptor], limit: 100)
            guard let exact = results.first(where: { $0.name == symbol }) else {
                throw NSError(domain: "CruxSmoke", code: 4, userInfo: [NSLocalizedDescriptionKey: "Missing exact search result: \(symbol)"])
            }
            let html = try String(contentsOf: exact.documentURL, encoding: .utf8)
            guard !html.isEmpty else { throw NSError(domain: "CruxSmoke", code: 5) }
            print("PASS search \(symbol): \(exact.relativePath), offline bytes=\(html.utf8.count)")
        }
        print("PASS archive install, metadata and local document reads: \(descriptor.name) \(descriptor.version ?? "unknown")")
    }
}
