// Lỗi này đánh dấu event sai contract để processor đưa thẳng vào DLQ thay vì retry vô ích.

export class InvalidInteractionEventError extends Error {
  // Giữ reason ngắn gọn để DLQ audit được nguyên nhân mà không lưu dữ liệu nhạy cảm.
  constructor(reason: string) {
    super(reason);
    this.name = InvalidInteractionEventError.name;
  }
}
