// Oracle 家族（Oracle、达梦、崖山）的函数 / 存储过程对象查询片段。崖山在 ALL_OBJECTS / USER_OBJECTS 里把函数登记成
// UDF 类型，Oracle 与达梦没有这种类型：查询一并纳入 UDF 并按 FUNCTION 返回，侧栏、补全与删除语句才能按函数处理。

/** 函数与存储过程的 OBJECT_TYPE 列表（含崖山的 UDF）。 */
export const ORACLE_ROUTINE_OBJECT_TYPES = "('FUNCTION','PROCEDURE','UDF')";

/** routine_type 列：UDF 归一为 FUNCTION。 */
export const ORACLE_ROUTINE_TYPE_COLUMN = "CASE OBJECT_TYPE WHEN 'UDF' THEN 'FUNCTION' ELSE OBJECT_TYPE END AS routine_type";
