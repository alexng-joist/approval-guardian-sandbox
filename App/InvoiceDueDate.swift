import Foundation

struct Invoice {
    let issuedAt: Date
    let paymentTermsDays: Int
}

enum InvoiceDueDate {
    static func dueDate(for invoice: Invoice, calendar: Calendar = .current) -> Date {
        guard invoice.paymentTermsDays >= 0 else {
            assertionFailure("Negative payment terms: \(invoice.paymentTermsDays)")
            return invoice.issuedAt
        }
        let termDays = invoice.paymentTermsDays
        let issueDay = calendar.startOfDay(for: invoice.issuedAt)
        return calendar.date(byAdding: .day, value: termDays, to: issueDay) ?? issueDay
    }
}
