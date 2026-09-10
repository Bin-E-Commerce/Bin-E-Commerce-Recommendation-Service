// DTO giới hạn replay từ internal operator, không cho browser gửi topic hoặc batch không kiểm soát.

import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsObject,
  IsString,
} from "class-validator";
import {
  RECOMMENDATION_CATALOG_TOPICS,
  RECOMMENDATION_EMBEDDING_REQUESTED_TOPIC,
  RECOMMENDATION_INTERACTIONS_TOPIC,
  RECOMMENDATION_PURCHASE_TOPICS,
} from "../../../../kafka/config/kafka.constants";

const replayableTopics = [
  RECOMMENDATION_INTERACTIONS_TOPIC,
  ...RECOMMENDATION_CATALOG_TOPICS,
  ...RECOMMENDATION_PURCHASE_TOPICS,
  RECOMMENDATION_EMBEDDING_REQUESTED_TOPIC,
];

export class CreateReplayJobDto {
  @IsString()
  @IsIn(replayableTopics)
  sourceTopic!: string;

  @IsArray()
  @ArrayMaxSize(100)
  @IsObject({ each: true })
  events!: Record<string, unknown>[];
}
