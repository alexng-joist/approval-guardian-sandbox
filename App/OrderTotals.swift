import Foundation

struct OrderLine {
    let quantity: Int
    let unitPrice: Decimal
}

enum OrderTotals {
    static func total(of lines: [OrderLine], taxRate: Decimal) -> Decimal {
        var subtotal: Decimal = 0
        for line in lines {
            subtotal += Decimal(line.quantity) * line.unitPrice
        }
        let total = subtotal + subtotal * taxRate
        return total
    }
}
