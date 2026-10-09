import Foundation

public protocol TextMerger {
    func merge(base: String, approved: String, upstream: String) -> String?
}

public struct GitMerger: TextMerger {
    public init() {}

    public func merge(base: String, approved: String, upstream: String) -> String? {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("syntax-rules-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let files = try [("approved", approved), ("base", base), ("upstream", upstream)].map { name, text in
                let url = directory.appendingPathComponent(name)
                try Data(text.utf8).write(to: url)
                return url.path
            }
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            process.arguments = ["git", "merge-file", "-p", "--diff-algorithm=histogram"] + files
            let output = Pipe()
            process.standardOutput = output
            process.standardError = FileHandle.nullDevice
            try process.run()
            let data = output.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            return process.terminationStatus == 0 ? String(decoding: data, as: UTF8.self) : nil
        } catch {
            return nil
        }
    }
}
