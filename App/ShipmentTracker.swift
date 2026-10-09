struct ShipmentTracker {
    let status: ShipmentStatus

    var isDelivered: Bool { status == .shipped }
}
