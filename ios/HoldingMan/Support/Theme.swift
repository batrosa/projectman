import SwiftUI
import UIKit

// ===== Дизайн-система ProjectMan (iOS, минимализм-2026) =====
// Адаптивные цвета: одна палитра для светлой и тёмной темы. Бренд — индиго
// web-версии (#6366F1); тёмная тема повторяет web (#0F172A), светлая —
// спокойный серо-голубой.

enum Theme {
    // Фон экрана
    static let background = adaptive(light: 0xF2F4F8, dark: 0x0F172A)
    // Карточки/панели
    static let surface = adaptive(light: 0xFFFFFF, dark: 0x1B2436)
    // Вторичные плашки внутри карточек (поля ввода, чипы)
    static let surfaceSecondary = adaptive(light: 0xEEF1F6, dark: 0x243049)
    // Волосяная обводка карточек (в тёмной теме заменяет тень)
    static let hairline = adaptive(light: 0xE4E8EF, dark: 0x2C3850)
    // Совместимость: «внутренняя» плашка (файлы, чипы) — как surfaceSecondary
    static let card = adaptive(light: 0xEEF1F6, dark: 0x243049)

    static let textPrimary = adaptive(light: 0x0F172A, dark: 0xF8FAFC)
    static let textSecondary = adaptive(light: 0x64748B, dark: 0x94A3B8)

    static let primary = Color(hex: 0x6366F1)
    static let primaryGradient = LinearGradient(
        colors: [Color(hex: 0x6366F1), Color(hex: 0x8B5CF6)],
        startPoint: .topLeading, endPoint: .bottomTrailing
    )

    static let danger = Color(hex: 0xEF4444)
    static let warning = Color(hex: 0xF59E0B)

    // Статусы задач — цвета вкладок web-доски
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

    private static func adaptive(light: UInt32, dark: UInt32) -> Color {
        Color(UIColor { trait in
            trait.userInterfaceStyle == .dark ? UIColor(hex: dark) : UIColor(hex: light)
        })
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

extension UIColor {
    convenience init(hex: UInt32) {
        self.init(
            red: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: 1
        )
    }
}

// ===== Тема оформления (Системная / Светлая / Тёмная) =====

enum Appearance: String, CaseIterable, Identifiable {
    case system, light, dark
    var id: String { rawValue }

    var titleRu: String {
        switch self {
        case .system: return "Системная"
        case .light: return "Светлая"
        case .dark: return "Тёмная"
        }
    }

    var icon: String {
        switch self {
        case .system: return "circle.lefthalf.filled"
        case .light: return "sun.max.fill"
        case .dark: return "moon.fill"
        }
    }

    var colorScheme: ColorScheme? {
        switch self {
        case .system: return nil
        case .light: return .light
        case .dark: return .dark
        }
    }
}

// ===== Общие компоненты =====

// Единый фон экранов
struct ScreenBackground: ViewModifier {
    func body(content: Content) -> some View {
        content
            .scrollContentBackground(.hidden)
            .background(Theme.background.ignoresSafeArea())
    }
}

// Карточка: скругление 16, волосяная обводка, мягкая тень в светлой теме
struct CardStyle: ViewModifier {
    @Environment(\.colorScheme) private var scheme
    var cornerRadius: CGFloat = 16

    func body(content: Content) -> some View {
        content
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .stroke(Theme.hairline, lineWidth: 1)
            )
            .shadow(
                color: scheme == .light ? Color.black.opacity(0.06) : .clear,
                radius: 14, y: 5
            )
    }
}

struct BrandLogoView: View {
    var size: CGFloat = 72

    var body: some View {
        Image("BrandLogo")
            .resizable()
            .scaledToFill()
            .frame(width: size, height: size)
            .clipShape(RoundedRectangle(cornerRadius: size * 0.24, style: .continuous))
            .shadow(color: Theme.primary.opacity(0.28), radius: size * 0.2, y: size * 0.08)
            .accessibilityHidden(true)
    }
}

extension View {
    func screenBackground() -> some View { modifier(ScreenBackground()) }
    func card(cornerRadius: CGFloat = 16) -> some View { modifier(CardStyle(cornerRadius: cornerRadius)) }
}

// Пружинное нажатие для любых карточек-кнопок
struct PressableStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .opacity(configuration.isPressed ? 0.92 : 1)
            .animation(.spring(duration: 0.25, bounce: 0.4), value: configuration.isPressed)
    }
}

// Главная кнопка: 52pt, градиент бренда, пружинное нажатие
struct PrimaryButtonStyle: ButtonStyle {
    var tint: Color?

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline.weight(.semibold))
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity)
            .frame(height: 52)
            .background {
                if let tint {
                    RoundedRectangle(cornerRadius: 15, style: .continuous).fill(tint)
                } else {
                    RoundedRectangle(cornerRadius: 15, style: .continuous).fill(Theme.primaryGradient)
                }
            }
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(.spring(duration: 0.25, bounce: 0.4), value: configuration.isPressed)
    }
}

// Вторичная кнопка: мягкая заливка цветом
struct SoftButtonStyle: ButtonStyle {
    var tint: Color = Theme.primary

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline.weight(.semibold))
            .foregroundStyle(tint)
            .frame(maxWidth: .infinity)
            .frame(height: 52)
            .background(tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 15, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 15, style: .continuous)
                    .stroke(tint.opacity(0.28), lineWidth: 1)
            )
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(.spring(duration: 0.25, bounce: 0.4), value: configuration.isPressed)
    }
}

// Общая подпись асинхронной кнопки: индикатор остаётся внутри той же кнопки,
// поэтому интерфейс мгновенно подтверждает нажатие и не «прыгает» между
// отдельной кнопкой и внешним ProgressView.
struct AsyncButtonLabel: View {
    let title: String
    let isLoading: Bool
    var systemImage: String? = nil
    var progressTint: Color = .white
    var fillsWidth = true

    var body: some View {
        HStack(spacing: 8) {
            if isLoading {
                ProgressView()
                    .controlSize(.small)
                    .tint(progressTint)
            } else if let systemImage {
                Image(systemName: systemImage)
            }
            Text(title)
                .lineLimit(1)
        }
        .frame(maxWidth: fillsWidth ? .infinity : nil)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(title)
        .accessibilityValue(isLoading ? "Выполняется" : "")
    }
}

// Чип статуса задачи
struct StatusChip: View {
    let status: BoardStatus
    var compact = false

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: status.icon)
                .font(.system(size: compact ? 9 : 10, weight: .bold))
            Text(status.singleRu)
                .font(.caption.weight(.semibold))
        }
        .foregroundStyle(Theme.color(for: status))
        .padding(.horizontal, compact ? 8 : 10)
        .padding(.vertical, compact ? 4 : 6)
        .background(Theme.color(for: status).opacity(0.13), in: Capsule())
    }
}

// Аватар с инициалами; цвет детерминирован именем
struct AvatarView: View {
    let name: String
    var size: CGFloat = 36

    private static let palette: [Color] = [
        Color(hex: 0x6366F1), Color(hex: 0x0EA5E9), Color(hex: 0x14B8A6),
        Color(hex: 0xF97316), Color(hex: 0xA855F7), Color(hex: 0xE11D48),
    ]

    private var initials: String {
        let parts = name.split(separator: " ").prefix(2)
        let letters = parts.compactMap { $0.first.map(String.init) }
        return letters.isEmpty ? "•" : letters.joined().uppercased()
    }

    private var color: Color {
        let hash = name.unicodeScalars.reduce(0) { ($0 &* 31 &+ Int($1.value)) & 0xFFFF }
        return Self.palette[hash % Self.palette.count]
    }

    var body: some View {
        ZStack {
            Circle().fill(color.opacity(0.16))
            Text(initials)
                .font(.system(size: size * 0.38, weight: .bold, design: .rounded))
                .foregroundStyle(color)
        }
        .frame(width: size, height: size)
    }
}

// Чип дедлайна («12.07.2026», красный при просрочке)
struct DeadlineChip: View {
    let deadline: String?
    let isOverdue: Bool

    private var label: String? {
        guard let deadline, let date = DateFormatter.isoDay.date(from: deadline) else { return nil }
        return DateFormatter.dayMonthYear.string(from: date)
    }

    var body: some View {
        if let label {
            HStack(spacing: 4) {
                Image(systemName: isOverdue ? "flame.fill" : "calendar")
                    .font(.system(size: 10, weight: .semibold))
                Text(label)
                    .font(.caption.weight(.semibold))
            }
            .foregroundStyle(isOverdue ? Theme.danger : Theme.textSecondary)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(
                (isOverdue ? Theme.danger.opacity(0.12) : Theme.surfaceSecondary),
                in: Capsule()
            )
        }
    }
}

// Пустое состояние экрана
struct EmptyStateView: View {
    let icon: String
    let title: String
    let message: String

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 40, weight: .light))
                .foregroundStyle(Theme.textSecondary.opacity(0.7))
                .symbolEffect(.pulse, options: .repeat(2))
            Text(title)
                .font(.headline)
                .foregroundStyle(Theme.textPrimary)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(Theme.textSecondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

extension DateFormatter {
    static let dayMonthShortRu: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "dd.MM.yyyy"
        f.locale = Locale(identifier: "ru_RU")
        return f
    }()
}
