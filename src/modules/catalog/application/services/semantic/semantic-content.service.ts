import { createHash } from "node:crypto";

import type { RecommendationSemanticProductContent } from "@common/kafka/events/recommendation.events";

// Service này tạo semantic text/hash deterministic; không đưa dữ liệu động hoặc định danh người dùng vào embedding.
export class SemanticContentService {
  // Chuẩn hóa Unicode/whitespace và loại HTML để cùng một nội dung luôn tạo cùng contentHash.
  normalize(value: string | null | undefined, maxLength: number): string {
    return (value ?? "")
      .replace(/<[^>]*>/g, " ")
      .normalize("NFC")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, maxLength);
  }

  // Giới hạn thuộc tính trước khi hash để payload event và chi phí embedding có bound rõ ràng.
  normalizeContent(input: RecommendationSemanticProductContent): RecommendationSemanticProductContent {
    const attributes = input.attributes
      .slice(0, 50)
      .map((attribute) => ({
        key: this.normalize(attribute.key, 128),
        value: this.normalize(attribute.value, 500),
      }))
      .filter((attribute) => attribute.key && attribute.value)
      .sort((left, right) => `${left.key}:${left.value}`.localeCompare(`${right.key}:${right.value}`));
    return {
      title: this.normalize(input.title, 255),
      shortDescription: input.shortDescription ? this.normalize(input.shortDescription, 1000) : null,
      description: input.description ? this.normalize(input.description, 4000) : null,
      brandName: input.brandName ? this.normalize(input.brandName, 255) : null,
      categoryPath: input.categoryPath ? this.normalize(input.categoryPath, 1000) : null,
      attributes,
      contentHash: "",
    };
  }

  // Hash chỉ phụ thuộc semantic fields, vì vậy đổi giá/stock/status chỉ cập nhật payload vector.
  withHash(input: RecommendationSemanticProductContent): RecommendationSemanticProductContent {
    const normalized = this.normalizeContent(input);
    const canonical = JSON.stringify({
      title: normalized.title,
      shortDescription: normalized.shortDescription,
      description: normalized.description,
      brandName: normalized.brandName,
      categoryPath: normalized.categoryPath,
      attributes: normalized.attributes,
    });
    return { ...normalized, contentHash: createHash("sha256").update(canonical).digest("hex") };
  }

  // Tạo plain text giàu ngữ cảnh để embedding model hiểu product mà không cần biết schema nội bộ.
  toEmbeddingText(content: RecommendationSemanticProductContent): string {
    const parts = [
      `Product: ${content.title}`,
      content.brandName ? `Brand: ${content.brandName}` : "",
      content.categoryPath ? `Category: ${content.categoryPath}` : "",
      content.shortDescription ? `Summary: ${content.shortDescription}` : "",
      content.description ? `Description: ${content.description}` : "",
      content.attributes.length ? `Attributes: ${content.attributes.map((item) => `${item.key}: ${item.value}`).join("; ")}` : "",
    ];
    return parts.filter(Boolean).join("\n").slice(0, 12000);
  }
}
