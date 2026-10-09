import Foundation

struct OrderLine {
    let quantity: Int
    let unitPrice: Decimal
}

enum OrderTotals {
    static func total(of lines: [OrderLine], taxRate: Decimal) -> Decimal {
        let net = lines.reduce(Decimal(0)) { $0 + Decimal($1.quantity) * $1.unitPrice }
        let gross = net + net * taxRate
        return gross
    }
}
