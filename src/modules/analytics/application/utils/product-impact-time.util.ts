// File này giữ các phép chuẩn hóa timestamp và tạo bucket ngày UTC cho analytics impact.
// Mọi ranh giới đều dùng UTC để không làm lệch mốc apply khi service chạy ở timezone khác.

import { BadRequestException } from "@nestjs/common";

// Parse timestamp theo một contract duy nhất và trả lỗi HTTP ổn định khi dữ liệu nội bộ bị sai.
export function parseProductImpactTimestamp(value: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException("Invalid product impact timestamp");
  }
  return parsed;
}

// Tạo danh sách ngày trình bày từ mốc bắt đầu đến mốc kết thúc exclusive.
// Không tạo thêm bucket ngày kế tiếp nếu afterTo rơi đúng 00:00 UTC.
export function createProductImpactDateRange(
  from: string,
  to: string,
): string[] {
  const start = parseProductImpactTimestamp(from);
  const end = parseProductImpactTimestamp(to);
  const cursor = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()),
  );
  const endExclusive = new Date(end.getTime() - 1);
  const endDay = new Date(
    Date.UTC(
      endExclusive.getUTCFullYear(),
      endExclusive.getUTCMonth(),
      endExclusive.getUTCDate(),
    ),
  );
  const dates: string[] = [];

  for (; cursor <= endDay; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    dates.push(cursor.toISOString().slice(0, 10));
  }

  return dates;
}
