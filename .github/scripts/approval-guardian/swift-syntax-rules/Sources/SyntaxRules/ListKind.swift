import SwiftSyntax

enum ListKind: Equatable {
    case topLevel
    case members
    case parameters
    case enumCases
    case switchCases

    static func of(_ node: Syntax) -> ListKind? {
        if node.is(CodeBlockItemListSyntax.self), node.parent?.is(SourceFileSyntax.self) == true { return .topLevel }
        if node.is(MemberBlockItemListSyntax.self) { return .members }
        if node.is(FunctionParameterListSyntax.self) { return .parameters }
        if node.is(EnumCaseElementListSyntax.self) { return .enumCases }
        if node.is(SwitchCaseListSyntax.self) { return .switchCases }
        return nil
    }

    var label: String {
        switch self {
        case .topLevel: return "top-level declarations"
        case .members: return "members"
        case .parameters: return "parameters"
        case .enumCases: return "enum cases"
        case .switchCases: return "switch cases"
        }
    }

    func elements(of list: Syntax) -> [Element] {
        switch self {
        case .topLevel:
            return list.cast(CodeBlockItemListSyntax.self).map { declarationElement(Syntax($0.item)) }
        case .members:
            return list.cast(MemberBlockItemListSyntax.self).map { declarationElement(Syntax($0.decl)) }
        case .parameters:
            return list.cast(FunctionParameterListSyntax.self).map { parameter in
                let name = (parameter.secondName ?? parameter.firstName).text
                return Element(
                    key: name == "_" ? "parameter _" : "parameter \(name)",
                    node: Syntax(parameter),
                    text: comparisonText(Syntax(parameter.with(\.trailingComma, nil))),
                    rule: name == "_" ? nil : .parameterAdditions
                )
            }
        case .enumCases:
            return list.cast(EnumCaseElementListSyntax.self).map { element in
                Element(
                    key: "case \(element.name.text)",
                    node: Syntax(element),
                    text: comparisonText(Syntax(element.with(\.trailingComma, nil))),
                    rule: .enumCaseAdditions
                )
            }
        case .switchCases:
            return list.cast(SwitchCaseListSyntax.self).map { item in
                guard case .switchCase(let switchCase) = item else {
                    return Element(key: "#if", node: Syntax(item), text: comparisonText(Syntax(item)), rule: nil)
                }
                let key: String
                switch switchCase.label {
                case .default: key = "default"
                case .case(let label): key = "case \(label.caseItems.trimmedDescription)"
                }
                return Element(key: key, node: Syntax(switchCase), text: comparisonText(Syntax(switchCase)), rule: .switchCaseAdditions)
            }
        }
    }

    func validate(resolved: [Element], added: Set<String>, list: Syntax, scope: String) throws {
        switch self {
        case .switchCases:
            try validateSwitchCases(resolved, added: added, scope: scope)
        case .enumCases:
            try validateEnumRawValues(around: list, scope: scope)
        case .members:
            if resolved.contains(where: { added.contains($0.key) && $0.node.is(EnumCaseDeclSyntax.self) }) {
                try validateEnumRawValues(around: list, scope: scope)
            }
        case .topLevel, .parameters:
            break
        }
    }
}

private func declarationElement(_ node: Syntax) -> Element {
    let (key, rule) = identity(of: node)
    return Element(key: key, node: node, text: comparisonText(node), rule: rule)
}

private func identity(of node: Syntax) -> (String, Rule?) {
    if let decl = node.as(ImportDeclSyntax.self) {
        let kind = decl.importKindSpecifier.map { "\($0.text) " } ?? ""
        return ("import \(kind)\(decl.path.trimmedDescription)", .importAdditions)
    }
    if let decl = node.as(FunctionDeclSyntax.self) { return ("func \(decl.name.text)", .memberAdditions) }
    if let decl = node.as(InitializerDeclSyntax.self) { return ("init\(decl.optionalMark?.text ?? "")", .memberAdditions) }
    if node.is(DeinitializerDeclSyntax.self) { return ("deinit", .memberAdditions) }
    if node.is(SubscriptDeclSyntax.self) { return ("subscript", .memberAdditions) }
    if let decl = node.as(VariableDeclSyntax.self) {
        let names = decl.bindings.map { $0.pattern.trimmedDescription }.joined(separator: ", ")
        return ("var \(names)", isStored(decl) ? .storedPropertyAdditions : .memberAdditions)
    }
    if let decl = node.as(EnumCaseDeclSyntax.self), let first = decl.elements.first {
        return ("case \(first.name.text)", .enumCaseAdditions)
    }
    if let decl = node.as(ClassDeclSyntax.self) { return ("type \(decl.name.text)", .memberAdditions) }
    if let decl = node.as(StructDeclSyntax.self) { return ("type \(decl.name.text)", .memberAdditions) }
    if let decl = node.as(EnumDeclSyntax.self) { return ("type \(decl.name.text)", .memberAdditions) }
    if let decl = node.as(ActorDeclSyntax.self) { return ("type \(decl.name.text)", .memberAdditions) }
    if let decl = node.as(ProtocolDeclSyntax.self) { return ("type \(decl.name.text)", .memberAdditions) }
    if let decl = node.as(ExtensionDeclSyntax.self) { return ("extension \(decl.extendedType.trimmedDescription)", .memberAdditions) }
    if let decl = node.as(TypeAliasDeclSyntax.self) { return ("typealias \(decl.name.text)", .memberAdditions) }
    if let decl = node.as(AssociatedTypeDeclSyntax.self) { return ("associatedtype \(decl.name.text)", .memberAdditions) }
    return ("unsupported \(node.kind)", nil)
}

private func isStored(_ decl: VariableDeclSyntax) -> Bool {
    decl.bindings.allSatisfy { binding in
        guard let accessorBlock = binding.accessorBlock else { return true }
        guard case .accessors(let accessors) = accessorBlock.accessors else { return false }
        return accessors.allSatisfy { ["willSet", "didSet"].contains($0.accessorSpecifier.text) }
    }
}

private func validateSwitchCases(_ resolved: [Element], added: Set<String>, scope: String) throws {
    var patterns: Set<String> = []
    var sawDefault = false
    for (index, element) in resolved.enumerated() {
        guard let switchCase = element.node.as(SwitchCaseSyntax.self) else {
            throw Violation("\(scope): switch with conditional compilation is not supported")
        }
        let isAdded = added.contains(element.key)
        switch switchCase.label {
        case .default:
            if isAdded { throw Violation("\(scope): adds a default case") }
            sawDefault = true
        case .case(let label):
            if isAdded && sawDefault { throw Violation("\(scope): adds \(element.key) after default") }
            for item in label.caseItems {
                guard item.whereClause == nil, let pattern = simplePattern(item.pattern) else {
                    throw Violation("\(scope): \(element.key) has a pattern whose overlap cannot be decided")
                }
                guard patterns.insert(pattern).inserted else {
                    throw Violation("\(scope): \(element.key) overlaps another case")
                }
            }
        }
        if isAdded && containsFallthrough(switchCase) {
            throw Violation("\(scope): \(element.key) uses fallthrough")
        }
        if index + 1 < resolved.count, added.contains(resolved[index + 1].key), containsFallthrough(switchCase) {
            throw Violation("\(scope): \(element.key) falls through into an added case")
        }
    }
}

private func simplePattern(_ pattern: PatternSyntax) -> String? {
    if let binding = pattern.as(ValueBindingPatternSyntax.self) {
        return simplePattern(binding.pattern)
    }
    guard let expression = pattern.as(ExpressionPatternSyntax.self)?.expression else { return nil }
    if let member = expression.as(MemberAccessExprSyntax.self) {
        return "case \(member.declName.baseName.text)"
    }
    if let call = expression.as(FunctionCallExprSyntax.self), let member = call.calledExpression.as(MemberAccessExprSyntax.self) {
        return "case \(member.declName.baseName.text)"
    }
    if expression.is(IntegerLiteralExprSyntax.self) || expression.is(StringLiteralExprSyntax.self)
        || expression.is(BooleanLiteralExprSyntax.self) || expression.is(FloatLiteralExprSyntax.self) {
        return "literal \(expression.trimmedDescription)"
    }
    return nil
}

private func containsFallthrough(_ node: SwitchCaseSyntax) -> Bool {
    final class Finder: SyntaxVisitor {
        var found = false
        override func visit(_ node: FallThroughStmtSyntax) -> SyntaxVisitorContinueKind {
            found = true
            return .skipChildren
        }
    }
    let finder = Finder(viewMode: .sourceAccurate)
    finder.walk(node)
    return finder.found
}

private let integerRawTypes: Set<String> = ["Int", "Int8", "Int16", "Int32", "Int64", "UInt", "UInt8", "UInt16", "UInt32", "UInt64"]

private func validateEnumRawValues(around list: Syntax, scope: String) throws {
    var current = list.parent
    while let node = current, node.asProtocol(DeclGroupSyntax.self) == nil {
        current = node.parent
    }
    guard let enumDecl = current?.as(EnumDeclSyntax.self),
          let rawType = enumDecl.inheritanceClause?.inheritedTypes.first?.type.trimmedDescription,
          integerRawTypes.contains(rawType) else { return }
    let implicit = enumDecl.memberBlock.members
        .compactMap { $0.decl.as(EnumCaseDeclSyntax.self) }
        .flatMap(\.elements)
        .contains { $0.rawValue == nil }
    if implicit {
        throw Violation("\(scope): adding cases to an \(rawType) enum with implicit raw values renumbers them")
    }
}
