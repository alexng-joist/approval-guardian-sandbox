struct ShipmentLabel {
    let status: ShipmentStatus

    var text: String { status.rawValue.capitalized }
}
