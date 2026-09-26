// swift-tools-version: 6.2
import PackageDescription
let package = Package(
    name: "CruxDocsetSmoke",
    platforms: [.macOS(.v26)],
    dependencies: [.package(path: "../../../Crux/Packages/CruxCore")],
    targets: [
        .executableTarget(name: "CruxDocsetSmoke", dependencies: [.product(name: "CruxCore", package: "CruxCore")]),
        .executableTarget(name: "CruxVersionSwitchSmoke", dependencies: [.product(name: "CruxCore", package: "CruxCore")]),
    ]
)
