package db

import (
	"fmt"
	"strings"

	"GoNavi-Wails/internal/logger"
)

// identity 元数据能力探测。
//
// ALL_TAB_IDENTITY_COLS 是 12c 起才有的视图。原实现把它做成与主查询并列的第二条
// 查询，于是每张表都要多一次往返；在 11g 上那一次还必然报错，只能降级成告警。
//
// 本文件把它改成连接级的一次性能力探测：
//   - 视图可用：主查询 LEFT JOIN identity 视图，每张表 1 次往返；
//   - 视图不可用：只跑主查询，不再发出注定失败的 identity 查询。
//
// 等价于把原来的 2N 次往返降成 N + 1 次。
//
// 只缓存「可用」的结论：视图的存在性与账号权限在连接期内稳定，但若探测因瞬时
// 故障（网络抖动、字典正在维护）失败，缓存负结果会让后续所有表永久丢失自增标记，
// 使跨库自动建表把目标端 ID 列建成普通数字列。负结果不缓存，代价是在 11g 上
// 每张表多一次注定失败的探测 —— 这与改动前的行为完全一致，不会更差。

// oracleIdentityProbeQuery 探测 identity 字典视图是否可用。
//
// ROWNUM = 0 让优化器短路，不返回任何行：这里只关心视图能否被解析。因为结果集
// 恒为空，判定依据是「返回了列定义」而不是「返回了行」。
func oracleIdentityProbeQuery(schema string) string {
	if strings.TrimSpace(schema) == "" {
		return `SELECT 1 AS "IDENTITY_PROBE" FROM user_tab_identity_cols WHERE ROWNUM = 0`
	}
	return fmt.Sprintf(`SELECT 1 AS "IDENTITY_PROBE" FROM all_tab_identity_cols WHERE owner = '%s' AND ROWNUM = 0`, escapeOracleMetadataLiteralExact(schema))
}

// oracleIdentityViewAvailable 报告 identity 视图是否可用于当前连接。
//
// 判定依据是「探测查询返回了列定义」：ROWNUM = 0 保证零行，因此不能按行数判断。
// 视图不存在时驱动会返回 ORA-00942，err 非 nil。
func (o *OracleDB) oracleIdentityViewAvailable(schema string) bool {
	cache := o.metadataCacheFor()
	if supported, ok := cache.identitySupported(); ok {
		return supported
	}
	_, columns, err := o.Query(oracleIdentityProbeQuery(schema))
	if err == nil && len(columns) > 0 {
		cache.storeIdentitySupported(true)
		return true
	}
	if oracleObjectMissingError(err) {
		// 视图确实不存在（11g 及更早）：这是连接期内的稳定事实，缓存后可让后续
		// 每张表都省掉这次注定失败的探测。
		cache.storeIdentitySupported(false)
		return false
	}
	// 瞬时故障不缓存。缓存的话会让后续所有表永久丢失自增标记，跨库自动建表
	// 就把目标端 ID 列建成普通数字列；代价只是多探测几次。
	logger.Infof("Oracle identity 字典视图探测失败，本次不缓存结论：%v", err)
	return false
}

// oracleObjectMissingError 判断错误是否表示「对象不存在」。
//
// 只认 ORA-00942（表或视图不存在）与 ORA-00904（标识符无效）：这两者说明视图
// 在当前版本/权限下不可用，是稳定事实。网络中断、字典维护等瞬时错误必须排除，
// 否则会把临时故障固化成能力缺失。
func oracleObjectMissingError(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToUpper(err.Error())
	return strings.Contains(message, "ORA-00942") || strings.Contains(message, "ORA-00904")
}
