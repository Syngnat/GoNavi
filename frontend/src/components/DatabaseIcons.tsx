import React from 'react';

// ─── 公共接口 ───────────────────────────────────────────────

export interface DbIconProps {
    size?: number;
    color?: string;
}

const IconFrame: React.FC<{
    size: number;
    children: React.ReactNode;
}> = ({ size, children }) => (
    <span
        data-db-icon-frame="true"
        style={{
            width: size,
            height: size,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
        }}
    >
        {children}
    </span>
);

// ─── 默认色表 ───────────────────────────────────────────────

const DB_DEFAULT_COLORS: Record<string, string> = {
    mysql:      '#00758F',
    mariadb:    '#003545',
    oceanbase:  '#0052CC',
    postgres:   '#336791',
    redis:      '#DC382D',
    mongodb:    '#47A248',
    elasticsearch: '#FEC514',
    jvm:        '#1677FF',
    kingbase:   '#1890FF',
    dameng:     '#E6002D',
    oracle:     '#F80000',
    sqlserver:  '#CC2927',
    clickhouse: '#FFBF00',
    sqlite:     '#003B57',
    duckdb:     '#FFC107',
    vastbase:   '#0066CC',
    opengauss:  '#2446A8',
    gaussdb:    '#0B7FAB',
    goldendb:   '#D97706',
    highgo:     '#00A86B',
    iris:       '#1F6FEB',
    tdengine:   '#2962FF',
    iotdb:      '#0F766E',
    rocketmq:   '#EA580C',
    mqtt:       '#0EA5A4',
    kafka:      '#F97316',
    rabbitmq:   '#FF6B35',
    nacos:      '#2E6BE6',
    chroma:     '#7C3AED',
    qdrant:     '#DC244C',
    milvus:     '#00A1EA',
    diros:      '#0050B3',
    starrocks:  '#00A6A6',
    sphinx:     '#2F5D62',
    custom:     '#888888',
};

export const getDbDefaultColor = (type: string): string =>
    DB_DEFAULT_COLORS[type?.toLowerCase()] || DB_DEFAULT_COLORS.custom;

/**
 * 获取数据库图标的静态资源路径（用于直接渲染 img 元素）
 */
export const getDbIconAssetSrc = (type: string): string => {
    const config = BRAND_ASSET_CONFIGS[type?.toLowerCase()];
    return config?.src || `/db-icons/${type?.toLowerCase()}.svg`;
};

/**
 * 获取图标容器建议的背景色。
 * 部分品牌图标（如 RocketMQ / IoTDB / MQTT / StarRocks）需要深色背景；
 * 其余大多数图标设计为在白色背景上展示。
 */
export const getDbIconContainerBg = (type: string): string => {
    const config = BRAND_ASSET_CONFIGS[type?.toLowerCase()];
    return config?.background || '#ffffff';
};

type BrandAssetConfig = {
    background?: string;
    borderColor?: string;
    iconScale?: number;
    src: string;
};

// ─── 官方品牌资源（文件在 /db-icons/ 下） ────────────────────

const BRAND_ASSET_CONFIGS: Record<string, BrandAssetConfig> = {
    mysql: { src: '/db-icons/mysql.svg' },
    mariadb: { src: '/db-icons/mariadb.svg' },
    oceanbase: { src: '/db-icons/oceanbase.png', iconScale: 0.72 },
    postgres: { src: '/db-icons/postgres.svg' },
    redis: { src: '/db-icons/redis.svg' },
    mongodb: { src: '/db-icons/mongodb.svg' },
    elasticsearch: { src: '/db-icons/elasticsearch.svg' },
    jvm: { src: '/db-icons/java.svg', iconScale: 0.68 },
    kingbase: { src: '/db-icons/kingbase.ico', iconScale: 0.72 },
    dameng: { src: '/db-icons/dameng.png', iconScale: 0.72 },
    oracle: { src: '/db-icons/oracle.ico', iconScale: 0.72 },
    sqlserver: { src: '/db-icons/sqlserver.svg' },
    clickhouse: { src: '/db-icons/clickhouse.svg' },
    sqlite: { src: '/db-icons/sqlite.svg' },
    duckdb: { src: '/db-icons/duckdb.svg' },
    vastbase: { src: '/db-icons/vastbase.svg', iconScale: 0.84 },
    opengauss: { src: '/db-icons/opengauss.ico', iconScale: 0.72 },
    gaussdb: { src: '/db-icons/gaussdb.ico', iconScale: 0.72 },
    goldendb: { src: '/db-icons/goldendb.ico', iconScale: 0.72 },
    highgo: { src: '/db-icons/highgo.ico', iconScale: 0.72 },
    iris: { src: '/db-icons/iris.png', iconScale: 0.72 },
    tdengine: { src: '/db-icons/tdengine.ico', iconScale: 0.72 },
    iotdb: {
        src: '/db-icons/iotdb.svg',
        background: '#0F766E',
        borderColor: '#0F766E',
        iconScale: 0.82,
    },
    rocketmq: {
        src: '/db-icons/rocketmq.png',
        background: '#0F172A',
        borderColor: '#EA580C',
        iconScale: 0.84,
    },
    mqtt: {
        src: '/db-icons/mqtt.svg',
        background: '#0F172A',
        borderColor: '#0EA5A4',
        iconScale: 0.84,
    },
    kafka: { src: '/db-icons/kafka.png', iconScale: 0.8 },
    rabbitmq: { src: '/db-icons/rabbitmq.svg', iconScale: 0.74 },
    nacos: { src: '/db-icons/nacos.svg' },
    chroma: { src: '/db-icons/chroma.svg', iconScale: 0.9 },
    qdrant: { src: '/db-icons/qdrant.svg', iconScale: 0.74 },
    milvus: { src: '/db-icons/milvus.svg', iconScale: 0.74 },
    diros: { src: '/db-icons/diros.svg' },
    starrocks: {
        src: '/db-icons/starrocks.png',
        background: '#0B1021',
        borderColor: '#00A6A6',
        iconScale: 0.84,
    },
    sphinx: { src: '/db-icons/sphinx.svg' },
};

const BRAND_ASSET_TYPES = new Set(Object.keys(BRAND_ASSET_CONFIGS));

/**
 * 检查指定数据库类型是否有官方品牌资源配置
 */
export const hasDbIconAsset = (type: string): boolean => {
    return BRAND_ASSET_TYPES.has(type?.toLowerCase());
};

/** 品牌图标：用 <img> 加载官方 svg/png/ico 资源 */
const BrandAssetIcon: React.FC<{ type: string; size: number; color?: string }> = ({ type, size, color }) => {
    const config = BRAND_ASSET_CONFIGS[type.toLowerCase()];
    const bgColor = color || config?.borderColor || getDbDefaultColor(type);
    const iconScale = config?.iconScale ?? 0.64;
    return (
        <IconFrame size={size}>
            <span style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: size, height: size, borderRadius: size * 0.22,
                background: config?.background || '#fff', border: `1.5px solid ${bgColor}`,
                flexShrink: 0, overflow: 'hidden', boxSizing: 'border-box',
            }}>
                <img
                    src={config?.src || `/db-icons/${type}.svg`}
                    alt={type}
                    width={Math.round(size * iconScale)}
                    height={Math.round(size * iconScale)}
                    style={{ display: 'block', objectFit: 'contain' }}
                />
            </span>
        </IconFrame>
    );
};

// ─── 各数据库图标 ───────────────────────────────────────────

// 有品牌官方资源的数据库
const MySQLIcon: React.FC<DbIconProps> = ({ size = 16, color }) => (
    <BrandAssetIcon type="mysql" size={size} color={color} />
);
const MariaDBIcon: React.FC<DbIconProps> = ({ size = 16, color }) => (
    <BrandAssetIcon type="mariadb" size={size} color={color} />
);
const OceanBaseIcon: React.FC<DbIconProps> = ({ size = 16, color }) => (
    <BrandAssetIcon type="oceanbase" size={size} color={color} />
);
const PostgresIcon: React.FC<DbIconProps> = ({ size = 16, color }) => (
    <BrandAssetIcon type="postgres" size={size} color={color} />
);
const RedisIcon: React.FC<DbIconProps> = ({ size = 16, color }) => (
    <BrandAssetIcon type="redis" size={size} color={color} />
);
const MongoDBIcon: React.FC<DbIconProps> = ({ size = 16, color }) => (
    <BrandAssetIcon type="mongodb" size={size} color={color} />
);
const ClickHouseIcon: React.FC<DbIconProps> = ({ size = 16, color }) => (
    <BrandAssetIcon type="clickhouse" size={size} color={color} />
);
const SQLiteIcon: React.FC<DbIconProps> = ({ size = 16, color }) => (
    <BrandAssetIcon type="sqlite" size={size} color={color} />
);

const OracleIcon: React.FC<DbIconProps> = ({ size = 16, color }) => (
    <BrandAssetIcon type="oracle" size={size} color={color} />
);
const SQLServerIcon: React.FC<DbIconProps> = ({ size = 16, color }) => (
    <BrandAssetIcon type="sqlserver" size={size} color={color} />
);
const DorisIcon: React.FC<DbIconProps> = ({ size = 16, color }) => (
    <BrandAssetIcon type="diros" size={size} color={color} />
);
const StarRocksIcon: React.FC<DbIconProps> = ({ size = 16, color }) => (
    <BrandAssetIcon type="starrocks" size={size} color={color} />
);
const SphinxIcon: React.FC<DbIconProps> = ({ size = 16, color }) => (
    <BrandAssetIcon type="sphinx" size={size} color={color} />
);
const DuckDBIcon: React.FC<DbIconProps> = ({ size = 16, color }) => (
    <BrandAssetIcon type="duckdb" size={size} color={color} />
);
const KingBaseIcon: React.FC<DbIconProps> = ({ size = 16, color }) => (
    <BrandAssetIcon type="kingbase" size={size} color={color} />
);
const DamengIcon: React.FC<DbIconProps> = ({ size = 16, color }) => (
    <BrandAssetIcon type="dameng" size={size} color={color} />
);
const VastBaseIcon: React.FC<DbIconProps> = ({ size = 16, color }) => (
    <BrandAssetIcon type="vastbase" size={size} color={color} />
);
const OpenGaussIcon: React.FC<DbIconProps> = ({ size = 16, color }) => (
    <BrandAssetIcon type="opengauss" size={size} color={color} />
);
const GaussDBIcon: React.FC<DbIconProps> = ({ size = 16, color }) => (
    <BrandAssetIcon type="gaussdb" size={size} color={color} />
);
const GoldenDBIcon: React.FC<DbIconProps> = ({ size = 16, color }) => (
    <BrandAssetIcon type="goldendb" size={size} color={color} />
);
const HighGoIcon: React.FC<DbIconProps> = ({ size = 16, color }) => (
    <BrandAssetIcon type="highgo" size={size} color={color} />
);
const IrisIcon: React.FC<DbIconProps> = ({ size = 16, color }) => (
    <BrandAssetIcon type="iris" size={size} color={color} />
);
const TDengineIcon: React.FC<DbIconProps> = ({ size = 16, color }) => (
    <BrandAssetIcon type="tdengine" size={size} color={color} />
);
const IoTDBIcon: React.FC<DbIconProps> = ({ size = 16, color }) => (
    <BrandAssetIcon type="iotdb" size={size} color={color} />
);
const RocketMQIcon: React.FC<DbIconProps> = ({ size = 16, color }) => (
    <BrandAssetIcon type="rocketmq" size={size} color={color} />
);
const MQTTIcon: React.FC<DbIconProps> = ({ size = 16, color }) => (
    <BrandAssetIcon type="mqtt" size={size} color={color} />
);
const KafkaIcon: React.FC<DbIconProps> = ({ size = 16, color }) => (
    <BrandAssetIcon type="kafka" size={size} color={color} />
);
const RabbitMQIcon: React.FC<DbIconProps> = ({ size = 16, color }) => (
    <BrandAssetIcon type="rabbitmq" size={size} color={color} />
);
const NacosIcon: React.FC<DbIconProps> = ({ size = 16, color }) => (
    <BrandAssetIcon type="nacos" size={size} color={color} />
);
const ChromaIcon: React.FC<DbIconProps> = ({ size = 16, color }) => (
    <BrandAssetIcon type="chroma" size={size} color={color} />
);
const QdrantIcon: React.FC<DbIconProps> = ({ size = 16, color }) => (
    <BrandAssetIcon type="qdrant" size={size} color={color} />
);
const MilvusIcon: React.FC<DbIconProps> = ({ size = 16, color }) => (
    <BrandAssetIcon type="milvus" size={size} color={color} />
);
const JVMIcon: React.FC<DbIconProps> = ({ size = 16, color }) => (
    <BrandAssetIcon type="jvm" size={size} color={color} />
);
const ElasticsearchIcon: React.FC<DbIconProps> = ({ size = 16, color }) => (
    <BrandAssetIcon type="elasticsearch" size={size} color={color} />
);

/** Custom — 齿轮图标 */
const CustomIcon: React.FC<DbIconProps> = ({ size = 16, color }) => {
    const c = color || DB_DEFAULT_COLORS.custom;
    return (
        <IconFrame size={size}>
            <svg width={size} height={size} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <rect x="0" y="0" width="24" height="24" rx="5" fill={c}/>
                <circle cx="12" cy="12" r="3.5" stroke="#fff" strokeWidth="1.5" fill="none"/>
                <path d="M12 4v2.5M12 17.5V20M4 12h2.5M17.5 12H20M6.34 6.34l1.77 1.77M15.89 15.89l1.77 1.77M6.34 17.66l1.77-1.77M15.89 8.11l1.77-1.77" stroke="#fff" strokeWidth="1.3" strokeLinecap="round"/>
            </svg>
        </IconFrame>
    );
};

// ─── 图标注册表 ─────────────────────────────────────────────

const DB_ICON_MAP: Record<string, React.FC<DbIconProps>> = {
    mysql: MySQLIcon,
    mariadb: MariaDBIcon,
    oceanbase: OceanBaseIcon,
    diros: DorisIcon,
    starrocks: StarRocksIcon,
    sphinx: SphinxIcon,
    postgres: PostgresIcon,
    redis: RedisIcon,
    mongodb: MongoDBIcon,
    jvm: JVMIcon,
    kingbase: KingBaseIcon,
    dameng: DamengIcon,
    oracle: OracleIcon,
    sqlserver: SQLServerIcon,
    clickhouse: ClickHouseIcon,
    sqlite: SQLiteIcon,
    duckdb: DuckDBIcon,
    vastbase: VastBaseIcon,
    opengauss: OpenGaussIcon,
    gaussdb: GaussDBIcon,
    goldendb: GoldenDBIcon,
    highgo: HighGoIcon,
    iris: IrisIcon,
    tdengine: TDengineIcon,
    iotdb: IoTDBIcon,
    rocketmq: RocketMQIcon,
    mqtt: MQTTIcon,
    kafka: KafkaIcon,
    rabbitmq: RabbitMQIcon,
    nacos: NacosIcon,
    chroma: ChromaIcon,
    qdrant: QdrantIcon,
    milvus: MilvusIcon,
    elasticsearch: ElasticsearchIcon,
    custom: CustomIcon,
};

/** 可选图标类型列表（用于图标选择器 UI） */
export const DB_ICON_TYPES: string[] = [
    'mysql', 'mariadb', 'oceanbase', 'postgres', 'redis', 'mongodb', 'jvm',
    'oracle', 'sqlserver', 'sqlite', 'duckdb', 'clickhouse', 'starrocks',
    'kingbase', 'dameng', 'vastbase', 'opengauss', 'gaussdb', 'goldendb', 'highgo', 'iris', 'tdengine', 'iotdb', 'rocketmq', 'mqtt', 'kafka', 'rabbitmq', 'nacos', 'chroma', 'qdrant', 'milvus', 'elasticsearch', 'custom',
];

/** 该类型是否有品牌图标资源 */
export const hasBrandSvg = (type: string): boolean => BRAND_ASSET_TYPES.has(type?.toLowerCase());

/** 获取数据库图标 React 节点 */
export const getDbIcon = (type: string, color?: string, size?: number): React.ReactNode => {
    const key = (type || 'custom').toLowerCase();
    const Component = DB_ICON_MAP[key] || CustomIcon;
    return <Component size={size} color={color} />;
};

type DbIconLabelTranslator = (key: string) => string;

const translateDbIconLabel = (
    translate: DbIconLabelTranslator | undefined,
    key: string,
    fallback: string,
): string => {
    if (!translate) return fallback;
    const translated = translate(key);
    return translated && translated !== key ? translated : fallback;
};

/** 获取数据库图标显示名称 */
export const getDbIconLabel = (type: string, translate?: DbIconLabelTranslator): string => {
    const labels: Record<string, string> = {
        mysql: 'MySQL', mariadb: 'MariaDB', oceanbase: 'OceanBase', postgres: 'PostgreSQL',
        redis: 'Redis', mongodb: 'MongoDB', jvm: 'JVM',
        oracle: 'Oracle',
        sqlserver: 'SQL Server', clickhouse: 'ClickHouse', sqlite: 'SQLite',
        starrocks: 'StarRocks',
        duckdb: 'DuckDB', kingbase: 'Kingbase', dameng: 'Dameng',
        vastbase: 'VastBase', opengauss: 'OpenGauss', gaussdb: 'GaussDB', goldendb: 'GoldenDB', highgo: 'HighGo', iris: 'InterSystems IRIS', tdengine: 'TDengine', iotdb: 'Apache IoTDB', rocketmq: 'RocketMQ', mqtt: 'MQTT', kafka: 'Kafka', rabbitmq: 'RabbitMQ', nacos: 'Nacos',
        chroma: 'Chroma',
        qdrant: 'Qdrant',
        milvus: 'Milvus',
        elasticsearch: 'Elasticsearch',
        custom: translateDbIconLabel(translate, 'connection_modal.db_icon_label.custom', 'Custom'),
    };
    return labels[type?.toLowerCase()] || type;
};

/** 预设颜色列表 */
export const PRESET_ICON_COLORS: string[] = [
    '#336791', '#00758F', '#DC382D', '#47A248', '#F80000',
    '#CC2927', '#1890FF', '#E6002D', '#FFBF00', '#2962FF',
    '#00A86B', '#0066CC', '#FF6B35', '#7C3AED',
];
