// swift-tools-version: 5.9
// sim-stream-encoder: raw BGRA frames on stdin → H.264 (VideoToolbox) on stdout.
// Optional upgrade to sim-stream's MJPEG path — see docs/architecture.md § H.264 encoder helper.
import PackageDescription

let package = Package(
    name: "sim-stream-encoder",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "sim-stream-encoder", targets: ["sim-stream-encoder"]),
    ],
    targets: [
        // Pure logic (arguments, AXe's frame layout, output framing) — no
        // VideoToolbox, so `swift test` covers it without a simulator.
        .target(name: "EncoderCore"),
        .executableTarget(name: "sim-stream-encoder", dependencies: ["EncoderCore"]),
        .testTarget(name: "EncoderCoreTests", dependencies: ["EncoderCore"]),
    ]
)
