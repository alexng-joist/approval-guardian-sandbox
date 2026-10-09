import Foundation
import SyntaxRules

let input = FileHandle.standardInput.readDataToEndOfFile()
do {
    let versions = try JSONDecoder().decode(FileVersions.self, from: input)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    FileHandle.standardOutput.write(try encoder.encode(SyntaxRules.check(versions)))
} catch {
    FileHandle.standardError.write(Data("invalid input: \(error)\n".utf8))
    exit(2)
}
