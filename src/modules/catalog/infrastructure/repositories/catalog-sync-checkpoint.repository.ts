import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { RecommendationCatalogSyncCheckpointEntity } from "../../../../database/catalog/entities/catalog-sync-checkpoint.entity";

// Persistence adapter cho checkpoint; không để bootstrap loop tự viết SQL trong application service.
@Injectable()
export class CatalogSyncCheckpointRepository {
  constructor(@InjectRepository(RecommendationCatalogSyncCheckpointEntity) private readonly repository: Repository<RecommendationCatalogSyncCheckpointEntity>) {}

  // Đọc page kế tiếp, mặc định bắt đầu từ page một khi chưa có checkpoint.
  async getNextPage(syncName: string): Promise<number> {
    return (await this.repository.findOne({ where: { syncName } }))?.nextPage ?? 1;
  }

  // Ghi checkpoint sau khi toàn bộ page đã upsert thành công.
  async saveNextPage(syncName: string, nextPage: number): Promise<void> {
    await this.repository.upsert({ syncName, nextPage }, ["syncName"]);
  }
}
