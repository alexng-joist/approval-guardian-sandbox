enum SwitchKind {
    case draft
}

func switchLabel(for kind: SwitchKind) -> String {
    switch kind {
    case .draft:
        return "Draft"
    }
}
