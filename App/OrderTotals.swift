import Foundation

struct OrderLine {
    let quantity: Int
    let unitPrice: Decimal
}

enum OrderTotals {
    static func total(of lines: [OrderLine], taxRate: Decimal) -> Decimal {
        let net = rounded(lines.reduce(Decimal(0)) { $0 + Decimal($1.quantity) * $1.unitPrice }, scale: 2)
        let gross = net + net * taxRate
        return gross
    }

    private static func rounded(_ value: Decimal, scale: Int) -> Decimal {
        var input = value
        var result = Decimal()
        NSDecimalRound(&result, &input, scale, .bankers)
        return result
    }
}
