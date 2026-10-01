package dbuser

import "context"

// Provider 是一个数据源族的账号管理实现。
//
// Plan 必须是纯函数（不做 IO），其余方法可访问 Env。Probe 失败的能力应降级
// 为 Features=false 并附带 Notice，而不是返回错误；只有连接级失败才返回 error。
type Provider interface {
	Family() Family
	Probe(ctx context.Context, env Env, target Target) (ServerProfile, error)
	List(ctx context.Context, env Env, profile ServerProfile, query ListQuery) ([]Principal, error)
	Describe(ctx context.Context, env Env, profile ServerProfile, query DescribeQuery) (PrincipalDetail, error)
	Impact(ctx context.Context, env Env, profile ServerProfile, ref PrincipalRef) (DropImpact, error)
	Plan(profile ServerProfile, request ChangeRequest) (Plan, error)
	ExportDDL(ctx context.Context, env Env, profile ServerProfile, ref PrincipalRef) (string, error)
}

// BuildPlan 在 Provider.Plan 之后做通用收尾：校验非空并计算指纹。
func BuildPlan(provider Provider, profile ServerProfile, request ChangeRequest) (Plan, error) {
	if err := ValidateRequestShape(profile, request); err != nil {
		return Plan{}, err
	}
	plan, err := provider.Plan(profile, request)
	if err != nil {
		return Plan{}, err
	}
	if len(plan.Statements) == 0 {
		return Plan{}, NewError(ErrCodeNothingToApply, nil)
	}
	plan.Fingerprint = Fingerprint(profile, plan)
	return plan, nil
}
