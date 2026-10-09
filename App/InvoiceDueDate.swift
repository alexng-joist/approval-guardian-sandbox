import Foundation

struct Invoice {
    let issuedAt: Date
    let paymentTermsDays: Int
}

enum InvoiceDueDate {
    static func dueDate(for invoice: Invoice, calendar: Calendar = .current) -> Date {
        let termDays = invoice.paymentTermsDays
        let issueDay = calendar.startOfDay(for: invoice.issuedAt)
        return calendar.date(byAdding: .day, value: termDays, to: issueDay) ?? issueDay
    }
}
