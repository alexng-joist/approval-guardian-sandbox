import SwiftParser
import SwiftSyntax

public enum Rule: String, Codable, CaseIterable {
    case importAdditions = "swift-import-additions@1"
    case enumCaseAdditions = "swift-enum-case-additions@1"
    case parameterAdditions = "swift-parameter-additions@1"
    case memberAdditions = "swift-member-additions@1"
    case storedPropertyAdditions = "swift-stored-property-additions@1"
    case switchCaseAdditions = "swift-switch-case-additions@1"
}

public struct FileVersions: Codable, Equatable {
    public var base: String
    public var approved: String
    public var upstream: String
    public var resolved: String

    public init(base: String, approved: String, upstream: String, resolved: String) {
        self.base = base
        self.approved = approved
        self.upstream = upstream
        self.resolved = resolved
    }
}

public struct ListChange: Codable, Equatable {
    public var rule: Rule
    public var scope: String
    public var approvedAdditions: [String]
    public var upstreamAdditions: [String]
}

public struct CheckResult: Codable, Equatable {
    public var ok: Bool
    public var reason: String?
    public var rules: [Rule]
    public var changes: [ListChange]

    static func violation(_ reason: String) -> CheckResult {
        CheckResult(ok: false, reason: reason, rules: [], changes: [])
    }
}

public enum SyntaxRules {
    public static func check(_ versions: FileVersions, merger: TextMerger = GitMerger()) -> CheckResult {
        let sources = Quad(versions.base, versions.approved, versions.upstream, versions.resolved)
        for (name, source) in sources.labeled where source.contains(Composer.placeholderMarker) {
            return .violation("\(name) contains the reserved placeholder marker")
        }
        let trees = sources.map { Parser.parse(source: $0) }
        for (name, tree) in trees.labeled where tree.hasError {
            return .violation("\(name) does not parse")
        }

        let composer = Composer(merger: merger)
        do {
            try composer.composeRegion(trees.map { Syntax($0) }, scope: "file")
        } catch let violation as Violation {
            return .violation(violation.reason)
        } catch {
            return .violation("\(error)")
        }

        let rules = Rule.allCases.filter { rule in composer.changes.contains { $0.rule == rule } }
        if rules.isEmpty {
            return .violation("difference is not explained by a supported rule")
        }
        return CheckResult(ok: true, reason: nil, rules: rules, changes: composer.changes)
    }
}

struct Violation: Error {
    let reason: String

    init(_ reason: String) {
        self.reason = reason
    }
}

struct Quad<T> {
    var base: T
    var approved: T
    var upstream: T
    var resolved: T

    init(_ base: T, _ approved: T, _ upstream: T, _ resolved: T) {
        self.base = base
        self.approved = approved
        self.upstream = upstream
        self.resolved = resolved
    }

    func map<U>(_ transform: (T) throws -> U) rethrows -> Quad<U> {
        Quad<U>(try transform(base), try transform(approved), try transform(upstream), try transform(resolved))
    }

    var all: [T] { [base, approved, upstream, resolved] }

    var labeled: [(String, T)] {
        [("base", base), ("approved", approved), ("upstream", upstream), ("resolved", resolved)]
    }
}

extension Quad where T: Equatable {
    var trivialOutcome: Bool? {
        if approved == base { return resolved == upstream }
        if upstream == base || approved == upstream { return resolved == approved }
        return nil
    }
}
