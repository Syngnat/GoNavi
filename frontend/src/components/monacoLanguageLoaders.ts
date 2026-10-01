/**
 * Monaco 内置语言分词器按需加载清单（每个条目一个纯副作用 import）。
 *
 * 刻意不引整包 monaco-editor：其 editor.main 附带 TS/CSS/HTML 语言服务及
 * 对应 worker（约 8MB）。这里的每个 contribution 只注册语言 id 与懒分词器，
 * 真正的 tokenizer 在语言首次使用时才加载。
 *
 * 覆盖范围为界面实际可请求的语言 id：
 * - sql/mysql/redis：查询编辑器、Redis 命令编辑器
 * - json：JSON 数据格、JVM 资源、Nacos json 配置
 * - yaml/xml/ini：Nacos 配置正文（yaml/yml、xml/html、properties）
 */
export const GONAVI_MONACO_LANGUAGE_LOADERS: ReadonlyArray<() => Promise<unknown>> = [
  () => import('monaco-editor/esm/vs/basic-languages/sql/sql.contribution.js'),
  () => import('monaco-editor/esm/vs/basic-languages/mysql/mysql.contribution.js'),
  () => import('monaco-editor/esm/vs/basic-languages/redis/redis.contribution.js'),
  () => import('monaco-editor/esm/vs/language/json/monaco.contribution.js'),
  () => import('monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution.js'),
  () => import('monaco-editor/esm/vs/basic-languages/xml/xml.contribution.js'),
  () => import('monaco-editor/esm/vs/basic-languages/ini/ini.contribution.js'),
];
