import SwiftUI

// Фирменные цвета HoldingMan — те же, что в web-версии (style.css :root),
// адаптированные под нативный iOS-интерфейс.
enum Theme {
    static let background = Color(hex: 0x0F172A)      // --bg-color
    static let surface = Color(hex: 0x1E293B)          // --sidebar-bg / --gantt-surface
    static let card = Color(hex: 0x334155).opacity(0.6) // --card-bg
    static let textPrimary = Color(hex: 0xF8FAFC)      // --text-primary
    static let textSecondary = Color(hex: 0x94A3B8)    // --text-secondary
    static let primary = Color(hex: 0x6366F1)          // --primary (indigo)
    static let danger = Color(hex: 0xEF4444)
    static let warning = Color(hex: 0xF59E0B)

    // Статусы задач — цвета вкладок доски и полос Ганта
    static let statusAssigned = Color(hex: 0x6366F1)
    static let statusInProgress = Color(hex: 0xF97316)
    static let statusReview = Color(hex: 0xEAB308)
    static let statusDone = Color(hex: 0x22C55E)

    static func color(for status: BoardStatus) -> Color {
        switch status {
        case .assigned: return statusAssigned
        case .inProgress: return statusInProgress
        case .review: return statusReview
        case .done: return statusDone
        }
    }
}

extension Color {
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: 1
        )
    }
}

// Единый фон экранов
struct ScreenBackground: ViewModifier {
    func body(content: Content) -> some View {
        content
            .scrollContentBackground(.hidden)
            .background(Theme.background.ignoresSafeArea())
    }
}

extension View {
    func screenBackground() -> some View { modifier(ScreenBackground()) }
}
