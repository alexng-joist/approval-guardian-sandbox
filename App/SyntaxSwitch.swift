enum SwitchKind {
    case draft
    case sent
    case archived
}

func switchLabel(for kind: SwitchKind) -> String {
    switch kind {
    case .draft:
        return "Draft"
    case .sent:
        return "Sent"
    case .archived:
        return "Archived"
    }
}
