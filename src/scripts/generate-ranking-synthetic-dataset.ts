// CLI offline đọc catalog read model và ghi dataset synthetic; không khởi động HTTP, không publish Kafka và không ghi profile.

import { ConfigService } from '@nestjs/config';
import { Pool, type QueryResultRow } from 'pg';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { RankingFeatureService } from '@/modules/recommendation/application/services/ranking/features/ranking-feature.service';
import { RankingSimulationService } from '@/modules/recommendation/application/services/offline/ranking-simulation.service';
import { RecommendationRuleService } from '@/modules/profiles/application/services/rules/recommendation-rule.service';
import type { RecommendationCatalogProduct } from '@/modules/catalog/application/types/catalog-product.type';
import type { RankingSyntheticDataset } from '@/modules/recommendation/application/types/offline/ranking-synthetic.types';

interface CatalogRow extends QueryResultRow {
    product_id: string;
    origin_type: 'INTERNAL' | 'EXTERNAL';
    name: string;
    slug: string;
    image_url: string | null;
    category_id: string | null;
    brand_id: string | null;
    seller_shop_id: string | null;
    external_shop_id: string | null;
    min_price: string;
    max_price: string;
    rating_avg: string | null;
    review_count: number;
    total_sold: number;
    status: 'ACTIVE' | 'INACTIVE' | 'DELETED';
    is_in_stock: boolean;
    created_at: Date | string;
    updated_at: Date | string;
    catalog_version: string;
    short_description: string | null;
    description: string | null;
    brand_name: string | null;
    category_path: string | null;
    semantic_attributes: Array<{ key: string; value: string }> | string | null;
    content_hash: string | null;
    embedding_status: RecommendationCatalogProduct['embeddingStatus'];
    embedding_model_version: string | null;
    embedding_dimensions: number | null;
}

interface CliOptions {
    users: number;
    sessions: number;
    targetEvents: number;
    seed: number;
    catalogLimit: number;
    output: string;
    referenceTime: Date;
}

// Nạp biến môi trường local mà không in secret; biến đã tồn tại bên ngoài luôn được ưu tiên.
async function loadEnvironmentFiles(): Promise<void> {
    const candidates = [
        resolve(process.cwd(), '../../.env.local'),
        resolve(process.cwd(), '../../.env'),
        resolve(process.cwd(), '.env.local'),
        resolve(process.cwd(), '.env'),
    ];
    for (const filePath of candidates) {
        if (!existsSync(filePath)) continue;
        const content = await readFile(filePath, 'utf8');
        for (const rawLine of content.split(/\r?\n/)) {
            const line = rawLine.trim();
            if (!line || line.startsWith('#')) continue;
            const separator = line.indexOf('=');
            if (separator <= 0) continue;
            const key = line.slice(0, separator).trim();
            const rawValue = line.slice(separator + 1).trim();
            const value =
                rawValue.startsWith('"') || rawValue.startsWith("'")
                    ? rawValue.replace(/^(['"])(.*)\1$/, '$2')
                    : (rawValue.split(/\s+#/, 1)[0] ?? '').trim();
            if (process.env[key] === undefined) process.env[key] = value;
        }
    }
}

// Parse CLI với default pilot, giới hạn số lượng để lệnh offline không vô tình quét dataset quá lớn.
function parseArguments(argv: string[]): CliOptions {
    const values = new Map<string, string>();
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (!argument?.startsWith('--'))
            throw new Error(`UNKNOWN_ARGUMENT_${argument ?? 'EMPTY'}`);
        const key = argument.slice(2);
        if (key === 'help') {
            printHelp();
            process.exit(0);
        }
        const value = argv[index + 1];
        if (!value || value.startsWith('--'))
            throw new Error(`MISSING_VALUE_FOR_${key}`);
        values.set(key, value);
        index += 1;
    }
    const referenceTime = new Date(
        values.get('reference-time') ?? '2026-01-01T00:00:00.000Z',
    );
    if (Number.isNaN(referenceTime.getTime()))
        throw new Error('INVALID_REFERENCE_TIME');
    return {
        users: parsePositive(values.get('users'), 1_000, 100_000),
        sessions: parsePositive(values.get('sessions'), 5_000, 1_000_000),
        targetEvents: parsePositive(values.get('events'), 100_000, 5_000_000),
        seed: parseInteger(values.get('seed'), 42),
        catalogLimit: parsePositive(
            values.get('catalog-limit'),
            20_000,
            100_000,
        ),
        output: resolve(
            process.cwd(),
            values.get('output') ??
                '../../services/ai-service/data/ranking-synthetic/seed-42',
        ),
        referenceTime,
    };
}

// Đọc catalog bằng query read-only, chỉ lấy product active còn hàng làm candidate source cho simulator.
async function loadCatalog(
    limit: number,
): Promise<RecommendationCatalogProduct[]> {
    const pool = new Pool({
        host: process.env.POSTGRES_HOST ?? 'localhost',
        port: Number(process.env.POSTGRES_PORT ?? '5432'),
        user: process.env.POSTGRES_USER,
        password: process.env.POSTGRES_PASSWORD,
        database: process.env.POSTGRES_DB ?? 'bin_ecommerce_recommendation',
        ssl:
            process.env.POSTGRES_SSL === 'true'
                ? { rejectUnauthorized: false }
                : false,
    });
    try {
        const result = await pool.query<CatalogRow>(
            `SELECT product_id, origin_type, name, slug, image_url,
                    category_id, brand_id, seller_shop_id, external_shop_id,
                    min_price, max_price, rating_avg, review_count, total_sold,
                    status, is_in_stock, created_at, updated_at,
                    catalog_version, short_description, description, brand_name,
                    category_path, semantic_attributes, content_hash,
                    embedding_status, embedding_model_version, embedding_dimensions
             FROM recommendation_catalog_products
             WHERE status = 'ACTIVE' AND is_in_stock = TRUE
             ORDER BY product_id ASC
             LIMIT $1`,
            [limit],
        );
        return result.rows.map(toCatalogProduct);
    } finally {
        await pool.end();
    }
}

// Map snake_case persistence row về application contract mà RankingFeatureService đang dùng.
function toCatalogProduct(row: CatalogRow): RecommendationCatalogProduct {
    const semanticAttributes =
        typeof row.semantic_attributes === 'string'
            ? JSON.parse(row.semantic_attributes)
            : (row.semantic_attributes ?? []);
    return {
        productId: row.product_id,
        originType: row.origin_type,
        name: row.name,
        slug: row.slug,
        imageUrl: row.image_url,
        categoryId: row.category_id,
        brandId: row.brand_id,
        sellerShopId: row.seller_shop_id,
        externalShopId: row.external_shop_id,
        minPrice: row.min_price,
        maxPrice: row.max_price,
        ratingAvg: row.rating_avg,
        reviewCount: row.review_count,
        totalSold: row.total_sold,
        status: row.status,
        isInStock: row.is_in_stock,
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at),
        catalogVersion: row.catalog_version,
        shortDescription: row.short_description,
        description: row.description,
        brandName: row.brand_name,
        categoryPath: row.category_path,
        semanticAttributes,
        contentHash: row.content_hash,
        embeddingStatus: row.embedding_status,
        embeddingModelVersion: row.embedding_model_version,
        embeddingDimensions: row.embedding_dimensions,
    };
}

// Ghi JSONL bounded theo từng dòng để dataset lớn không cần giữ thêm bản sao trong file writer.
async function writeJsonLines(
    filePath: string,
    values: unknown[],
): Promise<void> {
    const content = values.map((value) => JSON.stringify(value)).join('\n');
    await writeFile(filePath, `${content}${content ? '\n' : ''}`, 'utf8');
}

// Ghi dataset, split và manifest để trainer/evaluator có thể chạy độc lập với Recommendation Service.
async function writeDataset(
    output: string,
    dataset: RankingSyntheticDataset,
    options: CliOptions,
): Promise<void> {
    await mkdir(output, { recursive: true });
    const catalog = dataset.catalog.map((product) => ({
        ...product,
        createdAt: product.createdAt.toISOString(),
        updatedAt: product.updatedAt.toISOString(),
    }));
    const train = dataset.rows.filter((row) => row.split === 'train');
    const validation = dataset.rows.filter((row) => row.split === 'validation');
    const test = dataset.rows.filter((row) => row.split === 'test');
    const positiveRate = (rows: typeof dataset.rows): number =>
        rows.length === 0
            ? 0
            : Number(
                  (
                      rows.filter((row) => row.label === 1).length / rows.length
                  ).toFixed(6),
              );
    const manifest = {
        datasetVersion: 'ranking-synthetic-v1',
        featureSchemaVersion: 'ranking-features-v1',
        seed: options.seed,
        referenceTime: options.referenceTime.toISOString(),
        requestedUsers: options.users,
        requestedSessions: options.sessions,
        requestedEvents: options.targetEvents,
        catalogProducts: dataset.catalog.length,
        users: dataset.personas.length,
        sessions: dataset.sessions.length,
        events: dataset.events.length,
        rankingRows: dataset.rows.length,
        splits: {
            train: { rows: train.length, positiveRate: positiveRate(train) },
            validation: {
                rows: validation.length,
                positiveRate: positiveRate(validation),
            },
            test: { rows: test.length, positiveRate: positiveRate(test) },
        },
        writesToBusinessDatabase: false,
        publishesKafka: false,
    };
    await Promise.all([
        writeJsonLines(resolve(output, 'catalog.snapshot.jsonl'), catalog),
        writeJsonLines(resolve(output, 'personas.jsonl'), dataset.personas),
        writeJsonLines(resolve(output, 'sessions.jsonl'), dataset.sessions),
        writeJsonLines(resolve(output, 'events.jsonl'), dataset.events),
        writeJsonLines(resolve(output, 'ranking.dataset.jsonl'), dataset.rows),
        writeJsonLines(resolve(output, 'train.jsonl'), train),
        writeJsonLines(resolve(output, 'validation.jsonl'), validation),
        writeJsonLines(resolve(output, 'test.jsonl'), test),
        writeFile(
            resolve(output, 'manifest.json'),
            JSON.stringify(manifest, null, 2),
            'utf8',
        ),
        writeFile(
            resolve(output, 'metrics.json'),
            JSON.stringify(
                {
                    datasetVersion: 'ranking-synthetic-v1',
                    positiveRate: manifest.splits,
                    note: 'Data quality summary; model metrics are produced by AI Service evaluator.',
                },
                null,
                2,
            ),
            'utf8',
        ),
    ]);
}

// CLI entrypoint: load config, read catalog, generate deterministic data và đóng toàn bộ resource trước khi thoát.
async function main(): Promise<void> {
    await loadEnvironmentFiles();
    const options = parseArguments(process.argv.slice(2));
    const catalog = await loadCatalog(options.catalogLimit);
    const config = new ConfigService(process.env);
    const rules = new RecommendationRuleService(config);
    const features = new RankingFeatureService(rules);
    const simulation = new RankingSimulationService(features);
    const dataset = simulation.generate(catalog, options);
    await writeDataset(options.output, dataset, options);
    console.log(
        JSON.stringify({
            output: options.output,
            catalogProducts: dataset.catalog.length,
            users: dataset.personas.length,
            sessions: dataset.sessions.length,
            events: dataset.events.length,
            rankingRows: dataset.rows.length,
        }),
    );
}

// In hướng dẫn ngắn để người chạy offline không phải đọc source để biết option.
function printHelp(): void {
    console.log(`Usage: ranking-simulate [options]

Options:
  --users <number>          Synthetic users (default: 1000)
  --sessions <number>       Synthetic sessions (default: 5000)
  --events <number>         Target event budget (default: 100000)
  --seed <integer>          Deterministic seed (default: 42)
  --catalog-limit <number>  Catalog rows to read (default: 20000)
  --reference-time <iso>    Fixed feature clock (default: 2026-01-01T00:00:00Z)
  --output <path>            Output dataset directory
`);
}

// Parse số nguyên dương và giới hạn upper bound để CLI offline không làm nghẽn PostgreSQL hoặc đầy disk ngoài ý muốn.
function parsePositive(
    value: string | undefined,
    fallback: number,
    maximum: number,
): number {
    const parsed = value === undefined ? fallback : Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum)
        throw new Error(`INVALID_POSITIVE_NUMBER_${value ?? fallback}`);
    return parsed;
}

// Parse seed riêng vì seed có thể âm nhưng phải là integer để PRNG chuẩn hóa deterministic.
function parseInteger(value: string | undefined, fallback: number): number {
    const parsed = value === undefined ? fallback : Number(value);
    if (!Number.isInteger(parsed))
        throw new Error(`INVALID_INTEGER_${value ?? fallback}`);
    return parsed;
}

void main().catch((error: unknown) => {
    const failure = error as NodeJS.ErrnoException;
    console.error(
        JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
            errorName: error instanceof Error ? error.name : undefined,
            errorCode: failure?.code,
        }),
    );
    process.exitCode = 1;
});
