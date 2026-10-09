struct DiscountBadge {
    let discount: Discount

    var text: String { "-\(discount.percent)%" }
}
