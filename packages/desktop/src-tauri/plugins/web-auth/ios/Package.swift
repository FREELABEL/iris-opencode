// swift-tools-version:5.3
import PackageDescription

let package = Package(
  name: "tauri-plugin-iris-web-auth",
  platforms: [.iOS(.v15)],
  products: [
    .library(name: "tauri-plugin-iris-web-auth", type: .static, targets: ["tauri-plugin-iris-web-auth"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "tauri-plugin-iris-web-auth",
      dependencies: [.byName(name: "Tauri")],
      path: "Sources")
  ]
)
