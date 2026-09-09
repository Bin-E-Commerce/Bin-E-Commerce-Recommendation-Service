/// <reference types="jest" />
import { SemanticContentService } from "./semantic-content.service";

describe("SemanticContentService", () => {
  let target: SemanticContentService;

  beforeEach(() => {
    target = new SemanticContentService();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("withHash", () => {
    it("should produce the same hash when semantic attribute order changes", () => {
      // Arrange
      const first = {
        title: "  Camera <b>4K</b> ",
        shortDescription: "Portable camera",
        description: "A detailed description",
        brandName: "Bin",
        categoryPath: "Camera > Action",
        attributes: [
          { key: "lens", value: "Wide" },
          { key: "color", value: "Black" },
        ],
        contentHash: "",
      };
      const second = { ...first, attributes: [...first.attributes].reverse() };

      // Act
      const firstResult = target.withHash(first);
      const secondResult = target.withHash(second);

      // Assert
      expect(firstResult.contentHash).toBe(secondResult.contentHash);
      expect(firstResult.title).toBe("Camera 4K");
    });

    it("should change the hash when semantic content changes", () => {
      // Arrange
      const input = {
        title: "Camera",
        shortDescription: null,
        description: null,
        brandName: null,
        categoryPath: "Camera",
        attributes: [],
        contentHash: "",
      };

      // Act
      const original = target.withHash(input);
      const changed = target.withHash({ ...input, title: "Tripod" });

      // Assert
      expect(original.contentHash).not.toBe(changed.contentHash);
    });
  });

  describe("toEmbeddingText", () => {
    it("should include bounded semantic sections without dynamic catalog fields", () => {
      // Arrange
      const content = target.withHash({
        title: "Camera",
        shortDescription: "Portable",
        description: "Sharp image",
        brandName: "Bin",
        categoryPath: "Camera",
        attributes: [{ key: "resolution", value: "4K" }],
        contentHash: "",
      });

      // Act
      const text = target.toEmbeddingText(content);

      // Assert
      expect(text).toContain("Product: Camera");
      expect(text).toContain("Brand: Bin");
      expect(text).toContain("resolution: 4K");
      expect(text).not.toContain(content.contentHash);
    });
  });
});
