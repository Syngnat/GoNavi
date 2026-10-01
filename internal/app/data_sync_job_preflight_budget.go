package app

import (
	"context"
	"errors"
	"strings"
	"time"

	"GoNavi-Wails/internal/syncjob"
)

// 预检时长预算。原实现是固定的 60 秒总上限，对 Oracle 这类元数据视图本身就慢
// 的源端，表一多必然在查完之前被强制中止 —— 报出来的是「超时」，但用户看到的是
// 一个没有中文文案的英文报错，且「定位」找不到任何出错的表，因为确实没有表出错。
//
// 预算改为按启用映射数放宽，并提供硬上界：
//   - 基础的 dataSyncJobPreflightBaseTimeout 覆盖建连与健康任务的常规耗时；
//   - 每个启用映射额外获得 dataSyncJobPreflightPerMapping，对应逐表读取字段、
//     约束与索引的成本；
//   - dataSyncJobPreflightMaxTimeout 是交互式等待的忍耐上限。超过这个时长用户
//     已无法区分「很慢」与「卡死」，继续等待不再有交互价值。
const (
	dataSyncJobPreflightBaseTimeout = 60 * time.Second
	dataSyncJobPreflightPerMapping  = 3 * time.Second
	dataSyncJobPreflightMaxTimeout  = 10 * time.Minute
)

// dataSyncJobPreflightTimeoutFor 返回按映射规模放宽后的预检超时。
//
// 只统计启用中的映射：关闭的映射不会被校验，也就不该占用预算。映射数为 0 时
// 退回基础时长，保证空任务与只读比对任务仍有确定的上界。
func dataSyncJobPreflightTimeoutFor(definition syncjob.JobDefinition) time.Duration {
	budget := dataSyncJobPreflightBaseTimeout + time.Duration(countEnabledDataSyncMappings(definition))*dataSyncJobPreflightPerMapping
	if budget > dataSyncJobPreflightMaxTimeout {
		return dataSyncJobPreflightMaxTimeout
	}
	return budget
}

// countEnabledDataSyncMappings 统计启用中的映射数。关闭的映射不会被校验，
// 因此既不占时长预算，也不进进度分母 —— 否则超时提示会虚报总数。
func countEnabledDataSyncMappings(definition syncjob.JobDefinition) int {
	enabled := 0
	for _, mapping := range definition.Mappings {
		if mapping.Enabled {
			enabled++
		}
	}
	return enabled
}

// dataSyncJobMappingKey 是映射的稳定标识，用于把后端问题定位回前端映射行。
//
// 它必须与前端 mappingKeyFor() 算出同一个值：两侧都只依赖映射自身的源/目标
// 对象名，不依赖顺序或生成时机的随机 id，因此增删映射后仍然稳定。
//
// 不用 dataSyncJobMappingLabel() 作为标识：那是给人看的展示串（含 " -> "），
// 前端拿它无法匹配到任何一行。
func dataSyncJobMappingKey(mapping syncjob.TableMapping) string {
	source := qualifyDataSyncJobObject(mapping.SourceSchema, mapping.SourceTable)
	target := qualifyDataSyncJobObject(mapping.TargetSchema, mapping.TargetTable)
	return normalizeDataSyncJobMappingKeyPart(source) + " -> " + normalizeDataSyncJobMappingKeyPart(target)
}

// normalizeDataSyncJobMappingKeyPart 统一大小写与空白。
//
// 标识符大小写在库间不一致（Oracle 默认大写、PostgreSQL 默认小写），而前端
// 拿到的对象名已经过一次规范化；不统一大小写会让同一张表在两侧算出两个键。
func normalizeDataSyncJobMappingKeyPart(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

// dataSyncJobContextIssueCode 把 ctx 的中止原因映射成稳定的问题码。
//
// 超时与用户取消必须区分：前者意味着端点迟迟不响应，重试有意义；后者是用户
// 主动放弃，不建议重试。这个判定只能有一处实现 —— 内外层各写一份时，映射循环
// 记的是 request_cancelled，外层去重只看 preflight_timeout，同一次超时就会在
// 界面上报成两条。
func dataSyncJobContextIssueCode(err error) string {
	if errors.Is(err, context.DeadlineExceeded) {
		return "preflight_timeout"
	}
	return "request_cancelled"
}
