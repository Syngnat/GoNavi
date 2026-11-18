package app

import (
	"context"
	"errors"
	"strings"

	"GoNavi-Wails/internal/connection"
)

// localizeImportHeaderMetadataError 把带 i18n key 的表头元数据错误转换为当前语言文案。
func (a *App) localizeImportHeaderMetadataError(err error) error {
	var typed *importHeaderMetadataError
	if errors.As(err, &typed) {
		return errors.New(a.appText(typed.Key, typed.Params))
	}
	return err
}

// InferImportTableSchema 采样导入文件并推断目标表结构，供「按文件新建表并导入」使用。
// 只读取文件、不连接数据库：列名清洗按目标方言的标识符长度上限处理，类型保持逻辑类型，
// 由前端按具体方言映射，避免每新增一种数据源都要改推断逻辑。
func (a *App) InferImportTableSchema(config connection.ConnectionConfig, dbName, filePath string, options ImportFileOptions) connection.QueryResult {
	return a.inferImportTableSchemaContext(a.ctx, config, dbName, filePath, options)
}

func (a *App) inferImportTableSchemaContext(ctx context.Context, config connection.ConnectionConfig, dbName, filePath string, options ImportFileOptions) connection.QueryResult {
	_ = dbName
	if strings.TrimSpace(filePath) == "" {
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.import_file_empty", nil)}
	}
	if err := validateImportFileOptions(options); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	resolvedPath, err := a.resolveWebUploadReference(filePath, webUploadPurposeDataImport)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if ctx == nil {
		ctx = context.Background()
	}
	inference, err := inferImportTableSchema(ctx, resolvedPath, options, importIdentifierLimitRunes(resolveDDLDBType(config)))
	if err != nil {
		return connection.QueryResult{
			Success: false,
			Message: a.appText("file.backend.error.import_schema_inference_failed", map[string]any{
				"detail": a.localizeImportHeaderMetadataError(err).Error(),
			}),
		}
	}
	warnings := make([]string, 0, len(inference.Warnings))
	for _, warning := range inference.Warnings {
		warnings = append(warnings, a.appText(warning.Key, warning.Params))
	}
	return connection.QueryResult{
		Success: true,
		Data: ImportTableSchemaInference{
			TableName:   inference.TableName,
			Columns:     inference.Columns,
			Warnings:    warnings,
			SampledRows: inference.SampledRows,
			SampleLimit: inference.SampleLimit,
		},
	}
}
