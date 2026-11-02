import type { QueryStatementPlan } from '../queryEditorResultMessages';
import { resolveQueryResultColumnMetaForStatements, type QueryResultBackfillSchemaInput } from '../queryEditorColumnMetaBackfill';
import { hasQueryResultExpressionLabels } from '../queryEditorColumnMetaProjection';

export const backfillQueryEditorStatementPlans = async ({
    statementPlans, executedSourceStatements, sourceStatements, dbType, currentDb, schemaName, config, isCurrentRun,
}: QueryResultBackfillSchemaInput & {
    statementPlans: QueryStatementPlan[];
    executedSourceStatements: string[];
    sourceStatements: string[];
    isCurrentRun: () => boolean;
}): Promise<void> => {
    const targets = statementPlans.map((plan, index) => {
        const statement = executedSourceStatements[index] || sourceStatements[index] || '';
        return { plan, statement, hasExpressionLabels: hasQueryResultExpressionLabels(statement, dbType) };
    }).filter(target => (dbType === 'kingbase' || !target.plan.tableRef || target.hasExpressionLabels) && target.statement.trim());
    if (targets.length === 0) return;
    try {
        const maps = await resolveQueryResultColumnMetaForStatements(targets.map(target => ({
            statement: target.statement, dbType, currentDb, schemaName, config,
        })));
        if (!isCurrentRun()) return;
        maps.forEach((metaMap, index) => {
            const target = targets[index];
            // 表达式查询即使元数据暂不可用，也不能让网格退回实体表元数据并借用同名注释。
            if (metaMap || dbType === 'kingbase' || target.hasExpressionLabels) {
                target.plan.columnMetaMap = metaMap ?? (target.hasExpressionLabels ? {} : undefined);
            }
        });
    } catch {
        // 回填失败只影响表头显示，不影响执行。
    }
};
