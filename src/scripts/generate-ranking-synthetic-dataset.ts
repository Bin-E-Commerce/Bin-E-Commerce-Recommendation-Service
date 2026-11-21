// CLI offline tạo dataset ranking synthetic từ catalog DB hoặc catalog giả lập; không ghi profile hay publish Kafka.

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
import { SYNTHETIC_SESSION_INTERVAL_MS } from '@/modules/recommendation/application/types/offline/ranking-synthetic.types';

interface CatalogRow extends QueryResultRow {
    product_id: string;
    catalog_snapshot_at: Date | string;
    name: string;
    slug: string;
    image_url: string | null;
    category_id: string | null;
    brand_id: string | null;
    seller_shop_id: string | null;
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
    targetRows: number;
    seed: number;
    catalogLimit: number;
    syntheticCatalogSize: number | null;
    output: string;
    referenceTime: Date;
    referenceTimeProvided: boolean;
    catalogSnapshotAt: Date | null;
}

interface CatalogSnapshot {
    products: RecommendationCatalogProduct[];
    snapshotAt: Date;
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

// Parse CLI với giới hạn row budget; --events chỉ là alias cũ và không còn mang nghĩa số event đầu ra.
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
    // Từ chối hai tên cùng lúc để một lệnh không có target mơ hồ khi người dùng chuyển sang --rows.
    if (values.has('rows') && values.has('events'))
        throw new Error('ROWS_AND_EVENTS_ARGUMENTS_ARE_MUTUALLY_EXCLUSIVE');
    return {
        users: parsePositive(values.get('users'), 1_000, 100_000),
        sessions: parsePositive(values.get('sessions'), 5_000, 1_000_000),
        targetRows: parsePositive(
            values.get('rows') ?? values.get('events'),
            100_000,
            5_000_000,
        ),
        seed: parseInteger(values.get('seed'), 42),
        catalogLimit: parsePositive(
            values.get('catalog-limit'),
            20_000,
            100_000,
        ),
        syntheticCatalogSize: values.has('synthetic-catalog-size')
            ? parsePositive(values.get('synthetic-catalog-size'), 500, 100_000)
            : null,
        output: resolve(
            process.cwd(),
            values.get('output') ??
                '../../services/ai-service/data/ranking-synthetic/v3-seed-42',
        ),
        referenceTime,
        referenceTimeProvided: values.has('reference-time'),
        catalogSnapshotAt: null,
    };
}

// Tạo catalog giả có danh mục và thương hiệu phân tán để simulator chạy độc lập với dữ liệu PostgreSQL thật.
// Sản phẩm được tạo trước request đầu tiên để các phiên lịch sử không nhìn thấy catalog tương lai.
// ID có tiền tố synthetic giúp đầu ra không thể bị nhầm với catalog production; mọi thuộc tính đều xác định theo index.
function createSyntheticCatalog(
    size: number,
    firstRequestAt: Date,
): RecommendationCatalogProduct[] {
    const categoryCount = 32;
    const brandCount = 24;
    const sellerCount = 40;
    const dayMilliseconds = 86_400_000;

    return Array.from({ length: size }, (_, index) => {
        const sequence = String(index + 1).padStart(6, '0');
        const categoryNumber = index % categoryCount;
        const brandNumber =
            (Math.floor(index / categoryCount) * 7 + (index % 7)) % brandCount;
        const categoryId = `synthetic-category-${String(categoryNumber + 1).padStart(2, '0')}`;
        const brandId = `synthetic-brand-${String(brandNumber + 1).padStart(2, '0')}`;
        const createdAt = new Date(
            firstRequestAt.getTime() - ((index * 7919) % 730) * dayMilliseconds,
        );
        const minPrice = 100 + ((index * 137) % 10_000);

        return {
            productId: `synthetic-product-${sequence}`,
            name: `Sản phẩm giả lập ${sequence}`,
            slug: `synthetic-product-${sequence}`,
            imageUrl: null,
            categoryId,
            brandId,
            sellerShopId: `synthetic-seller-${String((index % sellerCount) + 1).padStart(2, '0')}`,
            minPrice: minPrice.toFixed(2),
            maxPrice: (minPrice + 50 + (index % 500)).toFixed(2),
            ratingAvg: (3 + (index % 21) / 10).toFixed(1),
            reviewCount: (index * 13) % 3_000,
            totalSold: (index * 37) % 10_000,
            status: 'ACTIVE',
            isInStock: true,
            createdAt,
            updatedAt: createdAt,
            catalogVersion: 'synthetic-catalog-v1',
            shortDescription: `Mô tả giả lập cho danh mục ${categoryNumber + 1}`,
            description: `Dữ liệu synthetic phục vụ kiểm thử ranking, sản phẩm ${sequence}.`,
            brandName: `Thương hiệu giả lập ${brandNumber + 1}`,
            categoryPath: `Danh mục giả lập / ${categoryNumber + 1}`,
            semanticAttributes: [
                { key: 'category', value: categoryId },
                { key: 'brand', value: brandId },
            ],
            contentHash: `synthetic-content-${sequence}`,
            embeddingStatus: 'READY',
            embeddingModelVersion: 'synthetic-embedding-v1',
            embeddingDimensions: 384,
        };
    });
}

// Đọc catalog bằng một câu SELECT để product và CURRENT_TIMESTAMP cùng thuộc database snapshot.
// Timestamp được gắn vào manifest và trở thành mốc sớm nhất cho các request tổng hợp.
// Vì sales/rating không có lịch sử trong read model, hàm từ chối cách dùng snapshot hiện tại để backfill quá khứ.
async function loadCatalog(limit: number): Promise<CatalogSnapshot> {
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
            `SELECT CURRENT_TIMESTAMP AS catalog_snapshot_at,
                    product_id, name, slug, image_url,
                    category_id, brand_id, seller_shop_id,
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
        const firstRow = result.rows[0];
        if (!firstRow) throw new Error('RECOMMENDATION_CATALOG_EMPTY');
        const snapshotAt = new Date(firstRow.catalog_snapshot_at);
        if (Number.isNaN(snapshotAt.getTime()))
            throw new Error('INVALID_CATALOG_SNAPSHOT_TIME');
        return {
            products: result.rows.map(toCatalogProduct),
            snapshotAt,
        };
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
        name: row.name,
        slug: row.slug,
        imageUrl: row.image_url,
        categoryId: row.category_id,
        brandId: row.brand_id,
        sellerShopId: row.seller_shop_id,
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
// Manifest ghi riêng catalog snapshot, target candidate rows và event count thực tế để lần chạy có thể tái lập.
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
        datasetVersion: 'ranking-synthetic-v3',
        featureSchemaVersion: 'ranking-features-v3',
        dataNature: 'synthetic',
        labelGeneration: 'position-independent-unforced-interaction-funnel-v2',
        catalogSource:
            options.syntheticCatalogSize === null
                ? 'recommendation_catalog_products'
                : 'synthetic_catalog',
        seed: options.seed,
        referenceTime: options.referenceTime.toISOString(),
        catalogSnapshotAt: options.catalogSnapshotAt?.toISOString() ?? null,
        firstRequestAt:
            dataset.sessions[0]?.createdAt ??
            options.referenceTime.toISOString(),
        lastRequestAt:
            dataset.sessions.at(-1)?.createdAt ??
            options.referenceTime.toISOString(),
        requestedUsers: options.users,
        requestedSessions: options.sessions,
        requestedCandidateRows: options.targetRows,
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
                    datasetVersion: 'ranking-synthetic-v3',
                    requestedCandidateRows: options.targetRows,
                    positiveRate: manifest.splits,
                    dataNature: 'synthetic',
                    note: 'Synthetic pipeline-development data; not evidence of real-user recommendation quality. Model metrics are produced by AI Service evaluator.',
                },
                null,
                2,
            ),
            'utf8',
        ),
    ]);
}

// CLI entrypoint chọn nguồn catalog, khóa mốc thời gian hợp lệ rồi gọi production feature builder.
// Với catalog DB, request đầu tiên phải nằm tại hoặc sau snapshot vì các aggregate chỉ có giá trị hiện tại.
// Không có reference-time rõ ràng thì mô phỏng chạy về phía trước từ snapshot; không dựng feature quá khứ giả.
// Output chỉ gồm artifact offline; catalog và event nghiệp vụ trong database không bị sửa.
async function main(): Promise<void> {
    await loadEnvironmentFiles();
    const options = parseArguments(process.argv.slice(2));
    let runOptions = options;
    let catalog: RecommendationCatalogProduct[];
    if (options.syntheticCatalogSize === null) {
        const snapshot = await loadCatalog(options.catalogLimit);
        // Mặc định mô phỏng bắt đầu tại thời điểm snapshot; reference-time do người dùng nhập phải ở sau snapshot.
        const referenceTime = options.referenceTimeProvided
            ? options.referenceTime
            : new Date(
                  snapshot.snapshotAt.getTime() +
                      options.sessions * SYNTHETIC_SESSION_INTERVAL_MS,
              );
        const firstRequestAt = new Date(
            referenceTime.getTime() -
                options.sessions * SYNTHETIC_SESSION_INTERVAL_MS,
        );
        if (firstRequestAt.getTime() < snapshot.snapshotAt.getTime())
            throw new Error('CATALOG_SNAPSHOT_CANNOT_BACKFILL_REQUEST_HISTORY');
        runOptions = {
            ...options,
            referenceTime,
            catalogSnapshotAt: snapshot.snapshotAt,
        };
        catalog = snapshot.products;
    } else {
        const firstRequestAt = new Date(
            options.referenceTime.getTime() -
                options.sessions * SYNTHETIC_SESSION_INTERVAL_MS,
        );
        catalog = createSyntheticCatalog(
            options.syntheticCatalogSize,
            firstRequestAt,
        );
    }
    const config = new ConfigService(process.env);
    const rules = new RecommendationRuleService(config);
    const features = new RankingFeatureService(rules);
    const simulation = new RankingSimulationService(features);
    const dataset = simulation.generate(catalog, runOptions);
    await writeDataset(runOptions.output, dataset, runOptions);
    console.log(
        JSON.stringify({
            output: runOptions.output,
            catalogProducts: dataset.catalog.length,
            users: dataset.personas.length,
            sessions: dataset.sessions.length,
            events: dataset.events.length,
            rankingRows: dataset.rows.length,
            requestedCandidateRows: runOptions.targetRows,
            catalogSnapshotAt:
                runOptions.catalogSnapshotAt?.toISOString() ?? null,
        }),
    );
}

// In hướng dẫn ngắn để người chạy offline không phải đọc source để biết option.
function printHelp(): void {
    console.log(`Usage: ranking-simulate [options]

Options:
  --users <number>          Synthetic users (default: 1000)
  --sessions <number>       Synthetic sessions (default: 5000)
  --rows <number>           Target ranking candidate-row budget (default: 100000)
  --events <number>         Legacy alias for --rows; event count depends on funnel outcomes
  --seed <integer>          Deterministic seed (default: 42)
  --catalog-limit <number>  Catalog rows to read (default: 20000)
  --synthetic-catalog-size <number>  Generate a local synthetic catalog and skip PostgreSQL
  --reference-time <iso>    Last request clock; DB mode requires its timeline after catalog snapshot
  --output <path>           Output dataset directory (default: ranking-synthetic/v3-seed-42)
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
