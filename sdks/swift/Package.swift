// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "Memnox",
    platforms: [.macOS(.v13), .iOS(.v16)],
    products: [.library(name: "Memnox", targets: ["Memnox"])],
    targets: [
        .target(name: "Memnox"),
        .testTarget(name: "MemnoxTests", dependencies: ["Memnox"]),
    ]
)
