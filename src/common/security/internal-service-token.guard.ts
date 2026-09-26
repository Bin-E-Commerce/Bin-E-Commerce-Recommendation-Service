// Guard dùng chung cho các endpoint chỉ nhận request từ service nội bộ.
// Guard không biết nghiệp vụ admin hay analytics; nó chỉ bảo vệ shared service token.

import {
    CanActivate,
    ExecutionContext,
    Injectable,
    UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

// Kiểm tra token nội bộ bằng so sánh constant-time để tránh biến endpoint service-to-service thành public API.
@Injectable()
export class InternalServiceTokenGuard implements CanActivate {
    constructor(private readonly config: ConfigService) {}

    // Chỉ cho request đi tiếp khi cả hai phía đã cấu hình token và độ dài token trùng nhau.
    canActivate(context: ExecutionContext): boolean {
        const request = context.switchToHttp().getRequest<Request>();
        const expected = this.config.get<string>('INTERNAL_SERVICE_TOKEN', '');
        const received = request.header('x-internal-service-token') ?? '';

        if (!expected || !received) {
            throw new UnauthorizedException('Invalid internal service token');
        }

        const expectedBuffer = Buffer.from(expected, 'utf8');
        const receivedBuffer = Buffer.from(received, 'utf8');
        if (
            expectedBuffer.length !== receivedBuffer.length ||
            !timingSafeEqual(expectedBuffer, receivedBuffer)
        ) {
            throw new UnauthorizedException('Invalid internal service token');
        }

        return true;
    }
}
