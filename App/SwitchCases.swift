enum SwitchKind {
    case draft
    case archived
}

func switchLabel(for kind: SwitchKind) -> String {
    switch kind {
    case .draft:
        return "Draft"
    case .archived:
        return "Archived"
    }
}
