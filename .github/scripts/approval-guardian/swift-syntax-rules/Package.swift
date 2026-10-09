// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "swift-syntax-rules",
    platforms: [.macOS(.v13)],
    dependencies: [
        .package(url: "https://github.com/swiftlang/swift-syntax.git", exact: "602.0.0"),
    ],
    targets: [
        .target(
            name: "SyntaxRules",
            dependencies: [
                .product(name: "SwiftParser", package: "swift-syntax"),
                .product(name: "SwiftSyntax", package: "swift-syntax"),
            ]
        ),
        .executableTarget(
            name: "swift-syntax-rules",
            dependencies: ["SyntaxRules"]
        ),
    ]
)
