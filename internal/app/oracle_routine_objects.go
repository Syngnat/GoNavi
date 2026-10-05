package app

// Oracle 家族（Oracle、达梦、崖山）的函数 / 存储过程对象查询片段，与前端 utils/oracleRoutineObjects.ts 一致：
// 崖山在 ALL_OBJECTS / USER_OBJECTS 里把函数登记成 UDF 类型，查询一并纳入并按 FUNCTION 返回。
const (
	oracleRoutineObjectTypes = "('FUNCTION','PROCEDURE','UDF')"
	oracleRoutineTypeColumn  = "CASE OBJECT_TYPE WHEN 'UDF' THEN 'FUNCTION' ELSE OBJECT_TYPE END AS routine_type"
)
