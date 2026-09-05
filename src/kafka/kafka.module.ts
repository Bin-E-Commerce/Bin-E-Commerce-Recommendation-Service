// Module này sở hữu kết nối Kafka của Recommendation Service, tách khỏi HTTP và persistence để dễ kiểm thử.

import { Global, Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { KafkaProducerService } from "./producers/kafka-producer.service";

@Global()
@Module({
  imports: [ConfigModule],
  providers: [KafkaProducerService],
  exports: [KafkaProducerService],
})
export class KafkaModule {}
