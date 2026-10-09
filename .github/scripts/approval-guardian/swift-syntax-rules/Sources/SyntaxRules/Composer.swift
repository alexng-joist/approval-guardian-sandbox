import SwiftSyntax

final class Composer {
    static let placeholderMarker = "⟦guardian-list"

    private let merger: TextMerger
    private(set) var changes: [ListChange] = []

    init(merger: TextMerger) {
        self.merger = merger
    }

    func composeRegion(_ nodes: Quad<Syntax>, scope: String) throws {
        switch nodes.map(comparisonText).trivialOutcome {
        case true?: return
        case false?: throw Violation("\(scope): resolved differs from the only changed side")
        case nil: break
        }

        let lists = nodes.map(outermostLists)
        let shapes = lists.map { $0.compactMap(ListKind.of) }
        guard shapes.all.allSatisfy({ $0 == shapes.base }) else {
            try mergeText(nodes.map(\.description), scope: scope)
            return
        }
        try mergeText(Quad(
            remainder(nodes.base, lists: lists.base),
            remainder(nodes.approved, lists: lists.approved),
            remainder(nodes.upstream, lists: lists.upstream),
            remainder(nodes.resolved, lists: lists.resolved)
        ), scope: scope)
        for index in lists.base.indices {
            try mergeList(
                Quad(lists.base[index], lists.approved[index], lists.upstream[index], lists.resolved[index]),
                kind: shapes.base[index],
                scope: scope
            )
        }
    }

    private func mergeText(_ texts: Quad<String>, scope: String) throws {
        switch texts.trivialOutcome {
        case true?: return
        case false?: throw Violation("\(scope): resolved differs from the only changed side")
        case nil: break
        }
        guard let merged = merger.merge(base: texts.base, approved: texts.approved, upstream: texts.upstream),
              merged == texts.resolved else {
            throw Violation("\(scope): content outside supported lists differs from a clean merge")
        }
    }

    private func mergeList(_ lists: Quad<Syntax>, kind: ListKind, scope: String) throws {
        let raw = lists.map(kind.elements)
        switch raw.map({ $0.map(\.text) }).trivialOutcome {
        case true?: return
        case false?: throw Violation("\(scope): resolved \(kind.label) differ from the only changed side")
        case nil: break
        }

        let elements = try assignKeys(raw, scope: scope)
        let base = elements.base
        let baseKeys = base.map(\.key)
        let existing = Set(baseKeys)
        for (name, side) in elements.labeled.dropFirst() {
            let keys = side.map(\.key)
            guard existing.isSubset(of: keys) else {
                throw Violation("\(scope): \(name) removes or renames existing \(kind.label)")
            }
            guard keys.filter(existing.contains) == baseKeys else {
                throw Violation("\(scope): \(name) reorders existing \(kind.label)")
            }
        }

        let approvedAdded = elements.approved.filter { !existing.contains($0.key) }
        var upstreamAdded = elements.upstream.filter { !existing.contains($0.key) }
        let approvedByKey = Dictionary(uniqueKeysWithValues: approvedAdded.map { ($0.key, $0) })
        upstreamAdded.removeAll { element in
            element.rule == .importAdditions && approvedByKey[element.key]?.text == element.text
        }
        if let clash = upstreamAdded.first(where: { approvedByKey[$0.key] != nil }) {
            throw Violation("\(scope): both sides add \(clash.key)")
        }
        if let unsupported = (approvedAdded + upstreamAdded).first(where: { $0.rule == nil }) {
            throw Violation("\(scope): adds unsupported element \(unsupported.key)")
        }

        let approvedGaps = gaps(elements.approved, existing: existing)
        let upstreamAdditionKeys = Set(upstreamAdded.map(\.key))
        let upstreamGaps = gaps(elements.upstream, existing: existing).map { $0.filter { upstreamAdditionKeys.contains($0.key) } }
        var expected: [String] = []
        for gap in 0...base.count {
            expected += (approvedGaps[gap] + upstreamGaps[gap]).map(\.key)
            if gap < base.count { expected.append(baseKeys[gap]) }
        }
        guard elements.resolved.map(\.key) == expected else {
            throw Violation("\(scope): resolved \(kind.label) are not the rule composition")
        }

        let resolvedByKey = Dictionary(uniqueKeysWithValues: elements.resolved.map { ($0.key, $0) })
        for addition in approvedAdded + upstreamAdded where resolvedByKey[addition.key]?.text != addition.text {
            throw Violation("\(scope): resolved changes added \(addition.key)")
        }

        let approvedByAllKeys = Dictionary(uniqueKeysWithValues: elements.approved.map { ($0.key, $0) })
        let upstreamByAllKeys = Dictionary(uniqueKeysWithValues: elements.upstream.map { ($0.key, $0) })
        for element in base {
            try composeRegion(Quad(
                element.node,
                approvedByAllKeys[element.key]!.node,
                upstreamByAllKeys[element.key]!.node,
                resolvedByKey[element.key]!.node
            ), scope: "\(scope) › \(element.key)")
        }

        let added = approvedAdded + upstreamAdded
        if added.isEmpty { return }
        try kind.validate(resolved: elements.resolved, added: Set(added.map(\.key)), list: lists.resolved, scope: scope)
        var rules: [Rule] = []
        for element in added where !rules.contains(element.rule!) {
            rules.append(element.rule!)
        }
        for rule in rules {
            changes.append(ListChange(
                rule: rule,
                scope: scope,
                approvedAdditions: approvedAdded.filter { $0.rule == rule }.map(\.text),
                upstreamAdditions: upstreamAdded.filter { $0.rule == rule }.map(\.text)
            ))
        }
    }

    private func assignKeys(_ raw: Quad<[Element]>, scope: String) throws -> Quad<[Element]> {
        var counts: [String: [Int]] = [:]
        for (index, version) in raw.all.enumerated() {
            for element in version {
                counts[element.key, default: [0, 0, 0, 0]][index] += 1
            }
        }
        for (key, perVersion) in counts where perVersion.max()! > 1 && Set(perVersion).count > 1 {
            throw Violation("\(scope): \(key) is ambiguous because its overload count changes")
        }
        return raw.map { version in
            var seen: [String: Int] = [:]
            return version.map { element in
                guard counts[element.key]!.max()! > 1 else { return element }
                let ordinal = seen[element.key, default: 0]
                seen[element.key] = ordinal + 1
                var keyed = element
                keyed.key = "\(element.key)#\(ordinal)"
                return keyed
            }
        }
    }

    private func gaps(_ side: [Element], existing: Set<String>) -> [[Element]] {
        var result: [[Element]] = [[]]
        for element in side {
            if existing.contains(element.key) {
                result.append([])
            } else {
                result[result.count - 1].append(element)
            }
        }
        return result
    }

    private func remainder(_ node: Syntax, lists: [Syntax]) -> String {
        var bytes = Array(node.description.utf8)
        let origin = node.position.utf8Offset
        for (index, list) in lists.enumerated().reversed() {
            let start = list.position.utf8Offset - origin
            let closingTrivia = list.nextToken(viewMode: .sourceAccurate)?.leadingTriviaLength.utf8Length ?? 0
            let end = min(list.endPosition.utf8Offset - origin + closingTrivia, bytes.count)
            bytes.replaceSubrange(start..<end, with: Array("\(Self.placeholderMarker) \(index)⟧".utf8))
        }
        return String(decoding: bytes, as: UTF8.self)
    }

    private func outermostLists(_ node: Syntax) -> [Syntax] {
        let finder = ListFinder(root: node)
        finder.walk(node)
        return finder.found
    }
}

struct Element {
    var key: String
    let node: Syntax
    let text: String
    let rule: Rule?
}

func comparisonText(_ node: Syntax) -> String {
    let comments = (node.leadingTrivia.pieces + node.trailingTrivia.pieces).compactMap { piece -> String? in
        switch piece {
        case .lineComment(let text), .blockComment(let text), .docLineComment(let text), .docBlockComment(let text):
            return text
        default:
            return nil
        }
    }
    return (comments + [node.trimmedDescription]).joined(separator: "\n")
}

private final class ListFinder: SyntaxAnyVisitor {
    private let root: SyntaxIdentifier
    private(set) var found: [Syntax] = []

    init(root: Syntax) {
        self.root = root.id
        super.init(viewMode: .sourceAccurate)
    }

    override func visitAny(_ node: Syntax) -> SyntaxVisitorContinueKind {
        if node.id != root, ListKind.of(node) != nil {
            found.append(node)
            return .skipChildren
        }
        return .visitChildren
    }
}
