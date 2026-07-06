import SwiftUI

// Дорожная карта Ганта — нативная адаптация web-версии:
// • всегда открывается на весь год (12 равных колонок-месяцев, вписано в экран);
// • тап по месяцу — зум в этот месяц по дням, кнопка «Весь год» — обратно;
// • полоса задачи: от даты создания до дедлайна, цвет = статус на доске,
//   просроченные — красная обводка; задачи без срока не отображаются;
// • линия «сегодня», подсветка выходных в режиме месяца.
struct GanttView: View {
    let project: Project
    @EnvironmentObject private var tasksStore: TasksStore

    @State private var year = Calendar.current.component(.year, from: Date())
    @State private var month: Int? = nil // nil = весь год, 0-11 = месяц

    private let labelWidth: CGFloat = 118

    private struct GanttItem: Identifiable {
        let id: String
        let task: TaskItem
        let start: Date
        let end: Date // включительно (день дедлайна)
    }

    var body: some View {
        VStack(spacing: 8) {
            toolbar
            chart
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
    }

    // MARK: — данные

    private var items: [GanttItem] {
        let calendar = Calendar.current
        return tasksStore.tasks.compactMap { task in
            guard let end = task.deadlineDate else { return nil } // без срока — не на диаграмме
            var start = task.createdAt.map { calendar.startOfDay(for: $0) } ?? end
            if start > end { start = end }
            return GanttItem(id: task.id, task: task, start: start, end: end)
        }
    }

    private var noDeadlineCount: Int {
        tasksStore.tasks.filter { $0.deadlineDate == nil }.count
    }

    private var rangeStart: Date {
        var comps = DateComponents(year: year, month: (month ?? 0) + 1, day: 1)
        if month == nil { comps.month = 1 }
        return Calendar.current.date(from: comps) ?? Date()
    }

    private var rangeEnd: Date { // exclusive
        let calendar = Calendar.current
        if let month {
            return calendar.date(byAdding: .month, value: 1,
                                 to: calendar.date(from: DateComponents(year: year, month: month + 1, day: 1))!)!
        }
        return calendar.date(from: DateComponents(year: year + 1, month: 1, day: 1))!
    }

    private var visibleItems: [GanttItem] {
        items
            .filter { $0.end >= rangeStart && $0.start < rangeEnd }
            .sorted { $0.start == $1.start ? $0.end < $1.end : $0.start < $1.start }
    }

    private var availableYears: [Int] {
        var years: Set<Int> = [Calendar.current.component(.year, from: Date()), year]
        let calendar = Calendar.current
        for item in items {
            years.insert(calendar.component(.year, from: item.start))
            years.insert(calendar.component(.year, from: item.end))
        }
        return years.sorted()
    }

    // MARK: — тулбар

    private var toolbar: some View {
        HStack(spacing: 8) {
            Button { year -= 1 } label: { Image(systemName: "chevron.left") }
                .buttonStyle(.bordered)

            Menu {
                ForEach(availableYears, id: \.self) { y in
                    Button(String(y)) { year = y }
                }
            } label: {
                Text(String(year))
                    .font(.headline)
                    .padding(.horizontal, 6)
            }
            .buttonStyle(.bordered)

            Button { year += 1 } label: { Image(systemName: "chevron.right") }
                .buttonStyle(.bordered)

            if let m = month {
                Button {
                    withAnimation(.spring(duration: 0.35)) { month = nil }
                } label: {
                    Label("Весь год", systemImage: "arrow.left")
                        .font(.subheadline.weight(.semibold))
                }
                .buttonStyle(.borderedProminent)

                Text(Self.monthNames[m])
                    .font(.headline)
                    .foregroundStyle(Theme.textPrimary)
            }

            Spacer()
        }
    }

    // MARK: — диаграмма

    private var chart: some View {
        GeometryReader { geo in
            let trackWidth = max(geo.size.width - labelWidth, 60)
            VStack(spacing: 0) {
                header(trackWidth: trackWidth)
                Divider().overlay(Theme.textSecondary.opacity(0.3))

                if visibleItems.isEmpty {
                    VStack(spacing: 8) {
                        Image(systemName: "chart.bar.doc.horizontal")
                            .font(.title)
                            .foregroundStyle(Theme.textSecondary)
                        Text(items.isEmpty
                             ? "В проекте нет задач со сроками"
                             : "Нет задач со сроками в этом периоде")
                            .font(.subheadline)
                            .foregroundStyle(Theme.textSecondary)
                        if noDeadlineCount > 0 {
                            Text("Без срока: \(noDeadlineCount) — не на диаграмме")
                                .font(.caption)
                                .foregroundStyle(Theme.textSecondary.opacity(0.7))
                        }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    ScrollView {
                        VStack(spacing: 0) {
                            ForEach(visibleItems) { item in
                                NavigationLink {
                                    TaskDetailView(task: item.task, project: project)
                                        .environmentObject(tasksStore)
                                } label: {
                                    row(item: item, trackWidth: trackWidth)
                                }
                                .buttonStyle(.plain)
                                Divider().overlay(Theme.textSecondary.opacity(0.12))
                            }
                            if noDeadlineCount > 0 {
                                Text("Без срока: \(noDeadlineCount) — не на диаграмме")
                                    .font(.caption)
                                    .foregroundStyle(Theme.textSecondary.opacity(0.7))
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(10)
                            }
                        }
                    }
                    .overlay(alignment: .topLeading) {
                        todayLine(trackWidth: trackWidth)
                    }
                }
            }
            .background(Theme.surface.opacity(0.45), in: RoundedRectangle(cornerRadius: 14))
            .clipShape(RoundedRectangle(cornerRadius: 14))
            .id("\(year)-\(month.map(String.init) ?? "year")")
            .transition(.asymmetric(
                insertion: .scale(scale: month == nil ? 1.08 : 0.92).combined(with: .opacity),
                removal: .scale(scale: month == nil ? 0.92 : 1.08).combined(with: .opacity)
            ))
            .animation(.spring(duration: 0.35), value: month)
        }
    }

    private func header(trackWidth: CGFloat) -> some View {
        HStack(spacing: 0) {
            Text("Задачи (\(visibleItems.count))")
                .font(.caption.weight(.bold))
                .foregroundStyle(Theme.textSecondary)
                .frame(width: labelWidth, alignment: .leading)
                .padding(.leading, 10)

            if let m = month {
                monthDaysHeader(month: m, trackWidth: trackWidth)
            } else {
                yearMonthsHeader(trackWidth: trackWidth)
            }
        }
        .padding(.vertical, 8)
    }

    private func yearMonthsHeader(trackWidth: CGFloat) -> some View {
        let colWidth = trackWidth / 12
        let now = Date()
        let currentMonth = Calendar.current.component(.month, from: now) - 1
        let currentYear = Calendar.current.component(.year, from: now)
        return HStack(spacing: 0) {
            ForEach(0..<12, id: \.self) { m in
                Button {
                    withAnimation(.spring(duration: 0.35)) { month = m }
                } label: {
                    Text(Self.monthShort[m])
                        .font(.caption2.weight(m == currentMonth && year == currentYear ? .bold : .semibold))
                        .foregroundStyle(
                            m == currentMonth && year == currentYear ? Theme.primary : Theme.textSecondary
                        )
                        .frame(width: colWidth)
                }
            }
        }
        .frame(width: trackWidth)
    }

    private func monthDaysHeader(month m: Int, trackWidth: CGFloat) -> some View {
        let days = daysInMonth(year: year, month: m)
        let colWidth = trackWidth / CGFloat(days)
        let today = Calendar.current.dateComponents([.year, .month, .day], from: Date())
        return HStack(spacing: 0) {
            ForEach(1...days, id: \.self) { d in
                let isToday = today.year == year && today.month == m + 1 && today.day == d
                // На узком экране номера через день, чтобы не слипались
                let show = days <= 16 || d % 2 == 1 || isToday
                Text(show ? "\(d)" : "")
                    .font(.system(size: 8, weight: isToday ? .bold : .regular))
                    .foregroundStyle(isToday ? Theme.primary : Theme.textSecondary)
                    .frame(width: colWidth)
            }
        }
        .frame(width: trackWidth)
    }

    private func row(item: GanttItem, trackWidth: CGFloat) -> some View {
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 2) {
                Text(item.task.title)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
                Text("\(DateFormatter.dayMonth.string(from: item.start)) – \(DateFormatter.dayMonth.string(from: item.end))")
                    .font(.system(size: 9))
                    .foregroundStyle(Theme.textSecondary)
            }
            .frame(width: labelWidth, alignment: .leading)
            .padding(.leading, 10)

            track(item: item, trackWidth: trackWidth)
        }
        .frame(height: 40)
    }

    private func track(item: GanttItem, trackWidth: CGFloat) -> some View {
        let interval = rangeEnd.timeIntervalSince(rangeStart)
        let dayLength: TimeInterval = 86_400
        let clampedStart = max(item.start, rangeStart)
        let clampedEnd = min(item.end.addingTimeInterval(dayLength), rangeEnd) // день дедлайна включительно
        let x = CGFloat(clampedStart.timeIntervalSince(rangeStart) / interval) * trackWidth
        let width = max(CGFloat(clampedEnd.timeIntervalSince(clampedStart) / interval) * trackWidth, 6)
        let clippedLeft = item.start < rangeStart
        let clippedRight = item.end.addingTimeInterval(dayLength) > rangeEnd
        let color = Theme.color(for: item.task.boardStatus)

        return ZStack(alignment: .leading) {
            gridBackground(trackWidth: trackWidth)

            UnevenRoundedRectangle(
                topLeadingRadius: clippedLeft ? 0 : 5,
                bottomLeadingRadius: clippedLeft ? 0 : 5,
                bottomTrailingRadius: clippedRight ? 0 : 5,
                topTrailingRadius: clippedRight ? 0 : 5
            )
            .fill(color)
            .frame(width: width, height: 14)
            .overlay(
                UnevenRoundedRectangle(
                    topLeadingRadius: clippedLeft ? 0 : 5,
                    bottomLeadingRadius: clippedLeft ? 0 : 5,
                    bottomTrailingRadius: clippedRight ? 0 : 5,
                    topTrailingRadius: clippedRight ? 0 : 5
                )
                .stroke(item.task.isOverdue ? Theme.danger : .clear, lineWidth: 1.5)
            )
            .offset(x: x)
        }
        .frame(width: trackWidth, height: 40)
        .clipped()
    }

    // Сетка колонок + затенение выходных (в режиме месяца)
    private func gridBackground(trackWidth: CGFloat) -> some View {
        let columns = month == nil ? 12 : daysInMonth(year: year, month: month!)
        let colWidth = trackWidth / CGFloat(columns)
        return HStack(spacing: 0) {
            ForEach(0..<columns, id: \.self) { index in
                Rectangle()
                    .fill(isWeekendColumn(index) ? Theme.textSecondary.opacity(0.07) : .clear)
                    .frame(width: colWidth)
                    .overlay(alignment: .leading) {
                        Rectangle()
                            .fill(Theme.textSecondary.opacity(0.12))
                            .frame(width: 0.5)
                    }
            }
        }
    }

    private func isWeekendColumn(_ index: Int) -> Bool {
        guard let m = month else { return false }
        var comps = DateComponents(year: year, month: m + 1, day: index + 1)
        comps.hour = 12
        guard let date = Calendar.current.date(from: comps) else { return false }
        let weekday = Calendar.current.component(.weekday, from: date)
        return weekday == 1 || weekday == 7 // вс / сб
    }

    @ViewBuilder
    private func todayLine(trackWidth: CGFloat) -> some View {
        let today = Calendar.current.startOfDay(for: Date())
        if today >= rangeStart && today < rangeEnd {
            let interval = rangeEnd.timeIntervalSince(rangeStart)
            let x = CGFloat((today.timeIntervalSince(rangeStart) + 43_200) / interval) * trackWidth
            Rectangle()
                .fill(Theme.primary)
                .frame(width: 1.5)
                .frame(maxHeight: .infinity)
                .offset(x: labelWidth + x)
                .allowsHitTesting(false)
                .shadow(color: Theme.primary.opacity(0.8), radius: 3)
        }
    }

    private func daysInMonth(year: Int, month: Int) -> Int {
        let comps = DateComponents(year: year, month: month + 1)
        guard let date = Calendar.current.date(from: comps),
              let range = Calendar.current.range(of: .day, in: .month, for: date) else { return 30 }
        return range.count
    }

    static let monthNames = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
                             "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"]
    static let monthShort = ["Янв", "Фев", "Мар", "Апр", "Май", "Июн",
                             "Июл", "Авг", "Сен", "Окт", "Ноя", "Дек"]
}
