import Foundation
import UIKit

struct Item {
    let id: Int

    init(id: Int) {
        self.id = id
    }
}

enum Status: String {
    case draft
}

final class ItemService {
    func label(for status: Status) -> String {
        switch status {
        case .draft:
            return "Draft"
        }
    }
}
