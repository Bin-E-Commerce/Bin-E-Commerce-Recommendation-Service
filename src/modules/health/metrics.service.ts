// Metrics service sở hữu các metric vận hành có cardinality thấp của Recommendation Service.
// Service không lưu userId, sessionId, requestId, productId hoặc raw query trong label.

import { Injectable } from "@nestjs/common";

type MetricLabels = Record<string, string>;

// Thu thập counter trong process và xuất Prometheus text format mà không thêm dependency runtime.
@Injectable()
export class MetricsService {
  private readonly counters = new Map<string, number>();
  private readonly startedAt = Date.now();

  // Tăng counter theo label hữu hạn; label động bị bỏ qua để tránh làm Prometheus phình không kiểm soát.
  increment(name: string, labels: MetricLabels = {}, amount = 1): void {
    const safeLabels = Object.entries(labels)
      .filter(([key]) =>
        ["status", "source", "surface", "variant", "error_code"].includes(key),
      )
      .sort(([left], [right]) => left.localeCompare(right));
    const key =
      name +
      "|" +
      safeLabels.map(([label, value]) => label + "=" + value).join(",");
    this.counters.set(key, (this.counters.get(key) ?? 0) + amount);
  }

  // Xuất snapshot metric có HELP/TYPE để Prometheus scrape ổn định và không chứa dữ liệu định danh.
  render(): string {
    const lines = [
      "# HELP recommendation_process_uptime_seconds Process uptime in seconds.",
      "# TYPE recommendation_process_uptime_seconds gauge",
      "recommendation_process_uptime_seconds " +
        Math.floor((Date.now() - this.startedAt) / 1000),
    ];
    const emitted = new Set<string>();
    for (const [key, value] of this.counters.entries()) {
      const parts = key.split("|");
      const name: string = parts[0] ?? "recommendation_invalid_metric";
      const rawLabels: string = parts[1] ?? "";
      if (!emitted.has(name)) {
        lines.push(
          "# HELP " + name + " Recommendation service operational counter.",
        );
        lines.push("# TYPE " + name + " counter");
        emitted.add(name);
      }
      const labels = rawLabels
        ? "{" +
          rawLabels
            .split(",")
            .map((item) => {
              const [label = "label", labelValue = "unknown"] = item.split("=");
              return label + '="' + labelValue.replaceAll('"', '\\"') + '"';
            })
            .join(",") +
          "}"
        : "";
      lines.push(name + labels + " " + value);
    }
    return lines.join("\n") + "\n";
  }
}
