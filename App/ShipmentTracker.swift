struct ShipmentTracker {
    let status: ShipmentStatus

    var isInTransit: Bool { status == .shipped }
}
