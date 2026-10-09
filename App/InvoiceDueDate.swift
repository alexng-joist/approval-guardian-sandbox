import Foundation

struct Invoice {
    let issuedAt: Date
    let paymentTermsDays: Int
}

enum InvoiceDueDate {
    static func dueDate(for invoice: Invoice, calendar: Calendar = .current) -> Date {
        let days = invoice.paymentTermsDays
        return calendar.date(byAdding: .day, value: days, to: invoice.issuedAt) ?? invoice.issuedAt
    }
}
